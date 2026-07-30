import Cdk
import CryptoKit
import Foundation

public enum CashuWalletError: LocalizedError, Equatable {
    case invalidMintURL
    case insecureMintURL
    case mintHasFunds
    case preparedSendMissing
    case outgoingTokenMissing
    case outgoingTokenRedeemed
    case unsupportedUnit
    case invalidRecoveryPhrase
    case invalidRecoveryBackup
    case walletReplacementBlocked
    case invalidLightningAmount
    case invalidLightningInvoice
    case lightningQuoteMissing
    case lightningPaymentMissing
    case lightningInvoiceExpired
    case lightningPaymentUncertain
    case mintTransferSameMint
    case mintTransferInsufficientBalance
    case pendingReceiveMissing
    case pendingReceiveInProgress
    case pendingReceiveAlreadySpent
    case invalidPaymentRequest
    case paymentRequestAmountRequired
    case paymentRequestMintUnavailable
    case paymentRequestInsufficientBalance
    case paymentRequestTransportUnavailable
    case paymentRequestUncertain
    case paymentRequestIdentityUnavailable
    case paymentRequestRelayUnavailable
    case paymentRequestNotFound
    case paymentRequestAlreadyCompleted
    case paymentRequestAlreadyProcessed
    case paymentRequestAmountMismatch

    public var errorDescription: String? {
        switch self {
        case .invalidMintURL:
            "Enter a complete Cashu mint URL."
        case .insecureMintURL:
            "Cashu mints must use HTTPS."
        case .mintHasFunds:
            "Move or spend this mint's balance before removing it."
        case .preparedSendMissing:
            "That send is no longer waiting for confirmation."
        case .outgoingTokenMissing:
            "That outgoing ecash token is no longer available."
        case .outgoingTokenRedeemed:
            "The mint confirms this token was redeemed, so it cannot be reclaimed."
        case .unsupportedUnit:
            "This first native wallet release supports sat-denominated mints."
        case .invalidRecoveryPhrase:
            "Enter a valid 12-word Cashu recovery phrase."
        case .invalidRecoveryBackup:
            "That file is not a supported Taskify Cashu wallet backup."
        case .walletReplacementBlocked:
            "Send or reclaim every balance and outgoing token before replacing this wallet."
        case .invalidLightningAmount:
            "Enter a Lightning receive amount greater than zero."
        case .invalidLightningInvoice:
            "Enter or scan a valid BOLT11 Lightning invoice."
        case .lightningQuoteMissing:
            "That Lightning invoice is no longer available. Create a new one."
        case .lightningPaymentMissing:
            "That Lightning payment is no longer waiting for confirmation."
        case .lightningInvoiceExpired:
            "That Lightning invoice has expired. Ask the recipient for a new one."
        case .lightningPaymentUncertain:
            "Taskify could not confirm the final payment state. Do not retry this invoice until you verify with the recipient or reopen the wallet while online."
        case .mintTransferSameMint:
            "Choose two different Cashu mints."
        case .mintTransferInsufficientBalance:
            "The sending mint does not have enough available balance for this transfer and its fees."
        case .pendingReceiveMissing:
            "That saved ecash token is no longer waiting to be redeemed."
        case .pendingReceiveInProgress:
            "Taskify is already redeeming that ecash token."
        case .pendingReceiveAlreadySpent:
            "The mint reports that this ecash token has already been spent."
        case .invalidPaymentRequest:
            "Enter or scan a valid Cashu payment request."
        case .paymentRequestAmountRequired:
            "Enter an amount greater than zero for this open Cashu request."
        case .paymentRequestMintUnavailable:
            "None of this wallet's mints are accepted by the Cashu request."
        case .paymentRequestInsufficientBalance:
            "The selected mint does not have enough available balance for this payment."
        case .paymentRequestTransportUnavailable:
            "This Cashu request does not include a Nostr or HTTP delivery method that Taskify can use."
        case .paymentRequestUncertain:
            "Taskify could not confirm whether the Cashu request was delivered after funds left the wallet. Do not retry it until you verify with the recipient."
        case .paymentRequestIdentityUnavailable:
            "Import your Taskify Nostr identity before creating a Cashu request."
        case .paymentRequestRelayUnavailable:
            "Add at least one healthy Nostr relay before creating a Cashu request."
        case .paymentRequestNotFound:
            "This payment does not match a Cashu request created by this device."
        case .paymentRequestAlreadyCompleted:
            "This single-use Cashu request has already been paid."
        case .paymentRequestAlreadyProcessed:
            "This Cashu payment was already processed."
        case .paymentRequestAmountMismatch:
            "The received ecash amount does not match the Cashu request."
        }
    }
}

public struct CashuRecoveryMaterial: Equatable, Sendable {
    public let mnemonic: String
    public let mintURLs: [String]

    public init(mnemonic: String, mintURLs: [String]) {
        self.mnemonic = mnemonic
        self.mintURLs = mintURLs
    }
}

public struct CashuMintRestoreSummary: Equatable, Sendable {
    public let mintURL: String
    public let spent: UInt64
    public let unspent: UInt64
    public let pending: UInt64

    public init(mintURL: String, spent: UInt64, unspent: UInt64, pending: UInt64) {
        self.mintURL = mintURL
        self.spent = spent
        self.unspent = unspent
        self.pending = pending
    }
}

public struct CashuMintTransferSummary: Equatable, Sendable {
    public let mintURL: String
    public let recovered: UInt64
    public let deposited: UInt64
    public let pending: UInt64

    public var fee: UInt64 { recovered > deposited ? recovered - deposited : 0 }

    public init(mintURL: String, recovered: UInt64, deposited: UInt64, pending: UInt64) {
        self.mintURL = mintURL
        self.recovered = recovered
        self.deposited = deposited
        self.pending = pending
    }
}

public struct CashuMintSummary: Identifiable, Equatable, Sendable {
    public let url: String
    public let name: String
    public let available: UInt64
    public let pending: UInt64
    public let reserved: UInt64
    public let isReachable: Bool

    public var id: String { url }
    public var total: UInt64 { available + pending + reserved }

    public init(
        url: String,
        name: String,
        available: UInt64,
        pending: UInt64,
        reserved: UInt64,
        isReachable: Bool
    ) {
        self.url = url
        self.name = name
        self.available = available
        self.pending = pending
        self.reserved = reserved
        self.isReachable = isReachable
    }
}

public enum CashuTransactionDirection: String, Codable, Equatable, Sendable {
    case incoming
    case outgoing
}

public enum CashuTransactionKind: String, Codable, Equatable, Sendable {
    case ecash
    case lightning
}

public enum CashuTransactionState: String, Codable, Equatable, Sendable {
    case pending
    case completed
    case failed
}

public enum CashuPaymentRequestTransport: String, Codable, Equatable, Sendable {
    case nostr
    case httpPost
}

public struct CashuPaymentRequestPreview: Equatable, Sendable {
    public let encoded: String
    public let paymentID: String?
    public let amount: UInt64?
    public let description: String?
    public let mintURLs: [String]
    public let singleUse: Bool?
    public let transports: [CashuPaymentRequestTransport]

    public init(
        encoded: String,
        paymentID: String?,
        amount: UInt64?,
        description: String?,
        mintURLs: [String],
        singleUse: Bool?,
        transports: [CashuPaymentRequestTransport]
    ) {
        self.encoded = encoded
        self.paymentID = paymentID
        self.amount = amount
        self.description = description
        self.mintURLs = mintURLs
        self.singleUse = singleUse
        self.transports = transports
    }
}

public struct CashuPaymentRequestPaymentResult: Equatable, Sendable {
    public let transactionID: String?
    public let mintURL: String
    public let amount: UInt64
    public let paymentID: String?

    public init(transactionID: String?, mintURL: String, amount: UInt64, paymentID: String?) {
        self.transactionID = transactionID
        self.mintURL = mintURL
        self.amount = amount
        self.paymentID = paymentID
    }
}

public struct CashuTransactionSummary: Identifiable, Equatable, Sendable {
    public let id: String
    public let mintURL: String
    public let direction: CashuTransactionDirection
    public let amount: UInt64
    public let fee: UInt64
    public let date: Date
    public let memo: String?
    public let kind: CashuTransactionKind
    public let quoteID: String?
    public let paymentRequest: String?
    public let paymentProof: String?
    public let cashuToken: String?
    public let cashuPaymentRequest: String?
    public let state: CashuTransactionState
    public let outgoingTokenStatus: CashuOutgoingTokenStatus?
    public let outgoingTokenID: String?
    public let tokenLastCheckedAt: Date?
    public let tokenSpentProofCount: Int?
    public let tokenProofCount: Int?

    public init(
        id: String,
        mintURL: String,
        direction: CashuTransactionDirection,
        amount: UInt64,
        fee: UInt64,
        date: Date,
        memo: String?,
        kind: CashuTransactionKind = .ecash,
        quoteID: String? = nil,
        paymentRequest: String? = nil,
        paymentProof: String? = nil,
        cashuToken: String? = nil,
        cashuPaymentRequest: String? = nil,
        state: CashuTransactionState = .completed,
        outgoingTokenStatus: CashuOutgoingTokenStatus? = nil,
        outgoingTokenID: String? = nil,
        tokenLastCheckedAt: Date? = nil,
        tokenSpentProofCount: Int? = nil,
        tokenProofCount: Int? = nil
    ) {
        self.id = id
        self.mintURL = mintURL
        self.direction = direction
        self.amount = amount
        self.fee = fee
        self.date = date
        self.memo = memo
        self.kind = kind
        self.quoteID = quoteID
        self.paymentRequest = paymentRequest
        self.paymentProof = paymentProof
        self.cashuToken = cashuToken
        self.cashuPaymentRequest = cashuPaymentRequest
        self.state = state
        self.outgoingTokenStatus = outgoingTokenStatus
        self.outgoingTokenID = outgoingTokenID
        self.tokenLastCheckedAt = tokenLastCheckedAt
        self.tokenSpentProofCount = tokenSpentProofCount
        self.tokenProofCount = tokenProofCount
    }
}

enum CashuPaymentArtifactValueKind: String, Codable, Equatable, Sendable {
    case cashuToken
    case lightningInvoice
    case cashuPaymentRequest
}

struct CashuPaymentArtifactRecord: Identifiable, Codable, Equatable, Sendable {
    let id: String
    let transactionID: String?
    let operationID: String?
    let quoteID: String?
    let mintURL: String
    let direction: CashuTransactionDirection
    let kind: CashuTransactionKind
    let value: String
    let valueKind: CashuPaymentArtifactValueKind?
    /// The bearer ecash represented by this transaction. Payment-request
    /// records keep it separately so history can retain both artifacts.
    var cashuToken: String?
    let amount: UInt64?
    let memo: String?
    let createdAt: Date
    var state: CashuTransactionState?
    var lastCheckedAt: Date?
    var feePaid: UInt64?
    var paymentProof: String?
    var expiresAt: Date?

    init(
        id: String = UUID().uuidString,
        transactionID: String? = nil,
        operationID: String? = nil,
        quoteID: String? = nil,
        mintURL: String,
        direction: CashuTransactionDirection,
        kind: CashuTransactionKind,
        value: String,
        valueKind: CashuPaymentArtifactValueKind? = nil,
        cashuToken: String? = nil,
        amount: UInt64? = nil,
        memo: String? = nil,
        createdAt: Date = Date(),
        state: CashuTransactionState? = nil,
        lastCheckedAt: Date? = nil,
        feePaid: UInt64? = nil,
        paymentProof: String? = nil,
        expiresAt: Date? = nil
    ) {
        self.id = id
        self.transactionID = transactionID
        self.operationID = operationID
        self.quoteID = quoteID
        self.mintURL = mintURL
        self.direction = direction
        self.kind = kind
        self.value = value
        self.valueKind = valueKind
        self.cashuToken = cashuToken
        self.amount = amount
        self.memo = memo
        self.createdAt = createdAt
        self.state = state
        self.lastCheckedAt = lastCheckedAt
        self.feePaid = feePaid
        self.paymentProof = paymentProof
        self.expiresAt = expiresAt
    }
}

public enum CashuOutgoingTokenStatus: String, Codable, Equatable, Sendable {
    case ready
    case partiallyRedeemed
    case redeemed
    case reclaimed
}

public struct CashuOutgoingToken: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let operationID: String
    public let mintURL: String
    public let amount: UInt64
    public let fee: UInt64
    public let token: String
    public let memo: String?
    public let createdAt: Date
    public var status: CashuOutgoingTokenStatus
    public var lastCheckedAt: Date?
    public var spentProofCount: Int?
    public var proofCount: Int?

    public init(
        id: String,
        operationID: String,
        mintURL: String,
        amount: UInt64,
        fee: UInt64,
        token: String,
        memo: String?,
        createdAt: Date,
        status: CashuOutgoingTokenStatus,
        lastCheckedAt: Date? = nil,
        spentProofCount: Int? = nil,
        proofCount: Int? = nil
    ) {
        self.id = id
        self.operationID = operationID
        self.mintURL = mintURL
        self.amount = amount
        self.fee = fee
        self.token = token
        self.memo = memo
        self.createdAt = createdAt
        self.status = status
        self.lastCheckedAt = lastCheckedAt
        self.spentProofCount = spentProofCount
        self.proofCount = proofCount
    }
}

public struct CashuWalletSnapshot: Equatable, Sendable {
    public let mints: [CashuMintSummary]
    public let transactions: [CashuTransactionSummary]
    public let outgoingTokens: [CashuOutgoingToken]

    public var available: UInt64 { mints.reduce(0) { $0 + $1.available } }
    public var pending: UInt64 { mints.reduce(0) { $0 + $1.pending } }
    public var reserved: UInt64 { mints.reduce(0) { $0 + $1.reserved } }

    public init(
        mints: [CashuMintSummary],
        transactions: [CashuTransactionSummary],
        outgoingTokens: [CashuOutgoingToken]
    ) {
        self.mints = mints
        self.transactions = transactions
        self.outgoingTokens = outgoingTokens
    }

    public static let empty = CashuWalletSnapshot(mints: [], transactions: [], outgoingTokens: [])
}

public struct CashuTokenPreview: Equatable, Sendable {
    public let mintURL: String
    public let amount: UInt64
    public let fee: UInt64?
    public let memo: String?

    public var receivedAmount: UInt64 {
        amount >= (fee ?? 0) ? amount - (fee ?? 0) : 0
    }

    public init(mintURL: String, amount: UInt64, fee: UInt64?, memo: String?) {
        self.mintURL = mintURL
        self.amount = amount
        self.fee = fee
        self.memo = memo
    }
}

public struct CashuOfflineTokenSummary: Equatable, Sendable {
    public let mintURL: String
    public let amount: UInt64
    public let memo: String?
}

public enum CashuPendingReceiveState: String, Codable, Equatable, Sendable {
    case queued
    // Retained so older journals can decode and discard spent-token records.
    case needsAttention
}

public struct CashuPendingReceive: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let token: String
    public let mintURL: String
    public let amount: UInt64
    public let memo: String?
    public let createdAt: Date
    public var state: CashuPendingReceiveState
    public var attemptCount: Int
    public var lastAttemptAt: Date?
    public var lastError: String?

    public init(
        id: String,
        token: String,
        mintURL: String,
        amount: UInt64,
        memo: String?,
        createdAt: Date,
        state: CashuPendingReceiveState = .queued,
        attemptCount: Int = 0,
        lastAttemptAt: Date? = nil,
        lastError: String? = nil
    ) {
        self.id = id
        self.token = token
        self.mintURL = mintURL
        self.amount = amount
        self.memo = memo
        self.createdAt = createdAt
        self.state = state
        self.attemptCount = attemptCount
        self.lastAttemptAt = lastAttemptAt
        self.lastError = lastError
    }

    public var isRecoverable: Bool { state == .queued }
}

public enum CashuReceiveSubmissionResult: Equatable, Sendable {
    case received(UInt64)
    /// This exact token was credited by this wallet in an earlier operation. It is a successful
    /// idempotent lookup, not a new balance change, so callers must not announce another receipt.
    case alreadyReceived(UInt64)
    case queued(CashuPendingReceive)
}

public struct CashuRecoveredReceive: Equatable, Sendable {
    public let pending: CashuPendingReceive
    public let receivedAmount: UInt64

    public init(pending: CashuPendingReceive, receivedAmount: UInt64) {
        self.pending = pending
        self.receivedAmount = receivedAmount
    }
}

public struct CashuPreparedSendQuote: Identifiable, Equatable, Sendable {
    public let id: UUID
    public let mintURL: String
    public let amount: UInt64
    public let fee: UInt64

    public init(id: UUID, mintURL: String, amount: UInt64, fee: UInt64) {
        self.id = id
        self.mintURL = mintURL
        self.amount = amount
        self.fee = fee
    }
}

public struct CashuLightningPaymentQuote: Identifiable, Equatable, Sendable {
    public let id: UUID
    public let quoteID: String
    public let mintURL: String
    public let invoice: String
    public let amount: UInt64
    public let feeReserve: UInt64
    public let walletFee: UInt64
    public let expiresAt: Date?

    public var maximumTotal: UInt64 {
        let amountAndReserve = amount.addingReportingOverflow(feeReserve)
        guard !amountAndReserve.overflow else { return .max }
        let total = amountAndReserve.partialValue.addingReportingOverflow(walletFee)
        return total.overflow ? .max : total.partialValue
    }

    public init(
        id: UUID,
        quoteID: String,
        mintURL: String,
        invoice: String,
        amount: UInt64,
        feeReserve: UInt64,
        walletFee: UInt64,
        expiresAt: Date?
    ) {
        self.id = id
        self.quoteID = quoteID
        self.mintURL = mintURL
        self.invoice = invoice
        self.amount = amount
        self.feeReserve = feeReserve
        self.walletFee = walletFee
        self.expiresAt = expiresAt
    }

    public func isExpired(at date: Date = Date()) -> Bool {
        guard let expiresAt else { return false }
        return expiresAt <= date
    }
}

public enum CashuLightningPaymentState: String, Equatable, Sendable {
    case completed
    case pending
}

public struct CashuLightningPaymentResult: Equatable, Sendable {
    public let quoteID: String
    public let mintURL: String
    public let amount: UInt64
    public let feePaid: UInt64?
    public let preimage: String?
    public let state: CashuLightningPaymentState

    public init(
        quoteID: String,
        mintURL: String,
        amount: UInt64,
        feePaid: UInt64?,
        preimage: String?,
        state: CashuLightningPaymentState
    ) {
        self.quoteID = quoteID
        self.mintURL = mintURL
        self.amount = amount
        self.feePaid = feePaid
        self.preimage = preimage
        self.state = state
    }
}

public enum CashuMintTransferState: String, Equatable, Sendable {
    case completed
    case pending
}

public struct CashuMintTransferResult: Equatable, Sendable {
    public let sourceMintURL: String
    public let destinationMintURL: String
    public let amount: UInt64
    public let receivedAmount: UInt64
    public let feePaid: UInt64?
    public let receiveQuoteID: String
    public let paymentQuoteID: String
    public let state: CashuMintTransferState

    public init(
        sourceMintURL: String,
        destinationMintURL: String,
        amount: UInt64,
        receivedAmount: UInt64,
        feePaid: UInt64?,
        receiveQuoteID: String,
        paymentQuoteID: String,
        state: CashuMintTransferState
    ) {
        self.sourceMintURL = sourceMintURL
        self.destinationMintURL = destinationMintURL
        self.amount = amount
        self.receivedAmount = receivedAmount
        self.feePaid = feePaid
        self.receiveQuoteID = receiveQuoteID
        self.paymentQuoteID = paymentQuoteID
        self.state = state
    }
}

public enum CashuLightningReceiveState: String, Codable, Equatable, Sendable {
    case unpaid
    case paid
    case pending
    case issued
    case expired
}

public struct CashuLightningReceiveQuote: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let mintURL: String
    public let amount: UInt64
    public let invoice: String
    public let createdAt: Date
    public let expiresAt: Date?
    public var state: CashuLightningReceiveState
    public var issuedAmount: UInt64

    public init(
        id: String,
        mintURL: String,
        amount: UInt64,
        invoice: String,
        createdAt: Date,
        expiresAt: Date?,
        state: CashuLightningReceiveState,
        issuedAmount: UInt64
    ) {
        self.id = id
        self.mintURL = mintURL
        self.amount = amount
        self.invoice = invoice
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.state = state
        self.issuedAmount = issuedAmount
    }

    public func isExpired(at date: Date = Date()) -> Bool {
        guard state == .unpaid, let expiresAt else { return state == .expired }
        return expiresAt <= date
    }

    public func isOutstanding(at date: Date = Date()) -> Bool {
        state != .issued && state != .expired && !isExpired(at: date)
    }
}

public actor CashuWalletService {
    private struct OutgoingTokenProofCheck {
        let id: String
        let proofs: [Proof]
    }

    private struct PreparedSendEntry {
        let send: PreparedSend
        let wallet: Wallet
        let mintURL: String
    }

    private struct PreparedLightningPaymentEntry {
        let melt: PreparedMelt
        let wallet: Wallet
        let mintURL: String
        let invoice: String
        let quoteID: String
        let amount: UInt64
    }

    private let repository: WalletRepository
    private let outgoingTokensURL: URL
    private let lightningReceiveQuotesURL: URL
    private let paymentArtifactsURL: URL
    private let pendingReceivesURL: URL
    private let createdPaymentRequestsURL: URL
    private let mnemonic: String
    private var outgoingTokens: [CashuOutgoingToken]
    private var lightningReceiveQuotes: [CashuLightningReceiveQuote]
    private var paymentArtifacts: [CashuPaymentArtifactRecord]
    private var pendingReceives: [CashuPendingReceive]
    private var createdPaymentRequests: [CashuCreatedPaymentRequest]
    private var lightningQuoteChecksInFlight: Set<String> = []
    private var pendingReceiveIDsInFlight: Set<String> = []
    private var preparedSends: [UUID: PreparedSendEntry] = [:]
    private var preparedLightningPayments: [UUID: PreparedLightningPaymentEntry] = [:]

    public init(databaseURL: URL, outgoingTokensURL: URL, mnemonic: String) throws {
        let normalizedMnemonic = Self.normalizedMnemonic(mnemonic)
        _ = try Cdk.mnemonicToEntropy(mnemonic: normalizedMnemonic)
        self.repository = try WalletRepository(
            mnemonic: normalizedMnemonic,
            store: .sqlite(path: databaseURL.path)
        )
        self.outgoingTokensURL = outgoingTokensURL
        self.lightningReceiveQuotesURL = outgoingTokensURL
            .deletingPathExtension()
            .appendingPathExtension("lightning-receive.json")
        self.paymentArtifactsURL = outgoingTokensURL
            .deletingPathExtension()
            .appendingPathExtension("payment-artifacts.json")
        self.pendingReceivesURL = outgoingTokensURL
            .deletingPathExtension()
            .appendingPathExtension("pending-receives.json")
        self.createdPaymentRequestsURL = outgoingTokensURL
            .deletingPathExtension()
            .appendingPathExtension("created-payment-requests.json")
        self.mnemonic = normalizedMnemonic
        self.outgoingTokens = Self.loadOutgoingTokens(from: outgoingTokensURL)
        self.lightningReceiveQuotes = Self.loadLightningReceiveQuotes(
            from: self.lightningReceiveQuotesURL
        )
        self.paymentArtifacts = Self.loadPaymentArtifacts(from: self.paymentArtifactsURL)
        self.pendingReceives = Self.loadPendingReceives(from: self.pendingReceivesURL)
        self.createdPaymentRequests = Self.loadCreatedPaymentRequests(
            from: self.createdPaymentRequestsURL
        )
    }

    public static func generateMnemonic() throws -> String {
        try Cdk.generateMnemonic()
    }

    public static func normalizedMnemonic(_ value: String) -> String {
        value.split(whereSeparator: \Character.isWhitespace).joined(separator: " ")
    }

    public static func validateMnemonic(_ value: String) -> Bool {
        let normalized = normalizedMnemonic(value)
        guard normalized.split(separator: " ").count >= 12 else { return false }
        return (try? Cdk.mnemonicToEntropy(mnemonic: normalized)) != nil
    }

    public static func walletIdentifier(for mnemonic: String) throws -> String {
        let entropy = try Cdk.mnemonicToEntropy(mnemonic: normalizedMnemonic(mnemonic))
        let digest = SHA256.hash(data: entropy)
        return digest.prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    public static func parseRecoveryMaterial(_ value: String) throws -> CashuRecoveryMaterial {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw CashuWalletError.invalidRecoveryPhrase }

        if trimmed.first == "{" {
            guard
                let data = trimmed.data(using: .utf8),
                let root = try? JSONSerialization.jsonObject(with: data),
                let backup = findSeedBackup(in: root),
                backup["type"] as? String == "nut13-wallet-backup",
                (backup["version"] as? NSNumber)?.intValue == 1,
                let phrase = backup["mnemonic"] as? String
            else {
                throw CashuWalletError.invalidRecoveryBackup
            }

            let mnemonic = normalizedMnemonic(phrase)
            guard validateMnemonic(mnemonic) else { throw CashuWalletError.invalidRecoveryPhrase }

            let counterMints = (backup["counters"] as? [String: Any])?.keys ?? Dictionary<String, Any>().keys
            let mints = counterMints.compactMap { try? normalizedMintURL($0) }.sorted()
            return CashuRecoveryMaterial(mnemonic: mnemonic, mintURLs: mints)
        }

        let mnemonic = normalizedMnemonic(trimmed)
        guard validateMnemonic(mnemonic) else { throw CashuWalletError.invalidRecoveryPhrase }
        return CashuRecoveryMaterial(mnemonic: mnemonic, mintURLs: [])
    }

    public static func normalizedMintURL(_ rawValue: String) throws -> String {
        var value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        while value.hasSuffix("/") { value.removeLast() }

        guard
            let components = URLComponents(string: value),
            let scheme = components.scheme?.lowercased(),
            let host = components.host,
            !host.isEmpty
        else {
            throw CashuWalletError.invalidMintURL
        }

        let isLocalDevelopment = host == "localhost" || host == "127.0.0.1" || host == "::1"
        guard scheme == "https" || (scheme == "http" && isLocalDevelopment) else {
            throw CashuWalletError.insecureMintURL
        }
        return value
    }

    public static func normalizedLightningInvoice(_ rawValue: String) throws -> String {
        var value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.lowercased().hasPrefix("lightning:") {
            value.removeFirst("lightning:".count)
        }
        value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let lowercased = value.lowercased()
        guard
            !value.isEmpty,
            lowercased.hasPrefix("lnbc")
                || lowercased.hasPrefix("lntb")
                || lowercased.hasPrefix("lnbcrt")
                || lowercased.hasPrefix("lnsb")
        else {
            throw CashuWalletError.invalidLightningInvoice
        }
        return value
    }

    public static func normalizedPaymentRequest(_ rawValue: String) throws -> String {
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { throw CashuWalletError.invalidPaymentRequest }

        if let components = URLComponents(string: value),
           components.scheme?.lowercased() == "bitcoin",
           let encoded = components.queryItems?.first(where: {
               $0.name.caseInsensitiveCompare("creq") == .orderedSame
           })?.value?.trimmingCharacters(in: .whitespacesAndNewlines),
           !encoded.isEmpty {
            return encoded
        }

        if value.lowercased().hasPrefix("cashu:") {
            let encoded = String(value.dropFirst("cashu:".count))
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard encoded.lowercased().hasPrefix("creqa")
                    || encoded.lowercased().hasPrefix("creqb1") else {
                throw CashuWalletError.invalidPaymentRequest
            }
            return encoded
        }

        let lowercase = value.lowercased()
        guard lowercase.hasPrefix("creqa") || lowercase.hasPrefix("creqb1") else {
            throw CashuWalletError.invalidPaymentRequest
        }
        return value
    }

    public static func previewPaymentRequest(_ rawValue: String) throws -> CashuPaymentRequestPreview {
        let encoded = try normalizedPaymentRequest(rawValue)
        let request: PaymentRequest
        do {
            request = try PaymentRequest.fromString(encoded: encoded)
        } catch {
            throw CashuWalletError.invalidPaymentRequest
        }
        guard request.unit() == nil || request.unit() == .sat else {
            throw CashuWalletError.unsupportedUnit
        }
        return CashuPaymentRequestPreview(
            encoded: encoded,
            paymentID: request.paymentId(),
            amount: request.amount()?.value,
            description: request.description(),
            mintURLs: request.mints(),
            singleUse: request.singleUse(),
            transports: request.transports().map { transport in
                switch transport.transportType {
                case .nostr: .nostr
                case .httpPost: .httpPost
                }
            }
        )
    }

    public static func paymentRequestAcceptsMint(
        _ preview: CashuPaymentRequestPreview,
        mintURL rawMintURL: String
    ) -> Bool {
        guard let mintURL = try? normalizedMintURL(rawMintURL) else { return false }
        let accepted = Set(preview.mintURLs.compactMap { try? normalizedMintURL($0) })
        return accepted.isEmpty || accepted.contains(mintURL)
    }

    public static func validateMintTransfer(
        amount: UInt64,
        sourceMintURL: String,
        destinationMintURL: String,
        available: UInt64
    ) throws -> (source: String, destination: String) {
        guard amount > 0 else { throw CashuWalletError.invalidLightningAmount }
        let source = try normalizedMintURL(sourceMintURL)
        let destination = try normalizedMintURL(destinationMintURL)
        guard source != destination else { throw CashuWalletError.mintTransferSameMint }
        guard amount <= available else { throw CashuWalletError.mintTransferInsufficientBalance }
        return (source, destination)
    }

    public func snapshot() async -> CashuWalletSnapshot {
        let wallets = await repository.getWallets()
        var mints: [CashuMintSummary] = []
        var transactions: [CashuTransactionSummary] = []

        for wallet in wallets {
            guard wallet.unit() == .sat else { continue }

            let mintURL = wallet.mintUrl().url
            let available = (try? await wallet.totalBalance().value) ?? 0
            let pending = (try? await wallet.totalPendingBalance().value) ?? 0
            let reserved = (try? await wallet.totalReservedBalance().value) ?? 0
            let info = try? await wallet.loadMintInfo()
            let name = info?.name?.trimmingCharacters(in: .whitespacesAndNewlines)

            mints.append(
                CashuMintSummary(
                    url: mintURL,
                    name: (name?.isEmpty == false ? name : nil) ?? Self.displayName(for: mintURL),
                    available: available,
                    pending: pending,
                    reserved: reserved,
                    isReachable: info != nil
                )
            )

            if let walletTransactions = try? await wallet.listTransactions(direction: nil) {
                try? await backfillOutgoingPaymentRequestTokens(
                    wallet: wallet,
                    transactions: walletTransactions
                )
                transactions.append(contentsOf: walletTransactions.map(transactionSummary))
            }
        }

        let representedLightningQuoteIDs = Set(transactions.compactMap { transaction in
            transaction.kind == .lightning ? transaction.quoteID : nil
        })
        for artifact in paymentArtifacts where
            artifact.kind == .lightning
                && artifact.direction == .outgoing
                && artifact.state != nil {
            guard let quoteID = artifact.quoteID,
                  !representedLightningQuoteIDs.contains(quoteID) else { continue }
            transactions.append(
                CashuTransactionSummary(
                    id: "lightning-quote-\(quoteID)",
                    mintURL: artifact.mintURL,
                    direction: .outgoing,
                    amount: artifact.amount ?? 0,
                    fee: artifact.feePaid ?? 0,
                    date: artifact.createdAt,
                    memo: nil,
                    kind: .lightning,
                    quoteID: quoteID,
                    paymentRequest: artifact.value,
                    paymentProof: artifact.paymentProof,
                    state: artifact.state ?? .pending
                )
            )
        }

        let representedTransactionIDs = Set(transactions.map(\.id))
        for artifact in paymentArtifacts where
            artifact.valueKind == .cashuPaymentRequest
                && artifact.state != nil {
            if let transactionID = artifact.transactionID,
               representedTransactionIDs.contains(transactionID) {
                continue
            }
            transactions.append(
                CashuTransactionSummary(
                    id: artifact.transactionID
                        ?? "cashu-request-\(artifact.direction.rawValue)-\(artifact.id)",
                    mintURL: artifact.mintURL,
                    direction: artifact.direction,
                    amount: artifact.amount ?? 0,
                    fee: artifact.feePaid ?? 0,
                    date: artifact.createdAt,
                    memo: artifact.memo,
                    kind: .ecash,
                    cashuToken: artifact.cashuToken,
                    cashuPaymentRequest: artifact.value,
                    state: artifact.state ?? .pending
                )
            )
        }

        return CashuWalletSnapshot(
            mints: mints.sorted {
                if $0.available != $1.available { return $0.available > $1.available }
                return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            },
            transactions: transactions.sorted { $0.date > $1.date },
            outgoingTokens: outgoingTokens.sorted { $0.createdAt > $1.createdAt }
        )
    }

    public func addMint(_ rawURL: String) async throws {
        let normalized = try Self.normalizedMintURL(rawURL)
        let mintURL = MintUrl(url: normalized)
        guard await !repository.hasMint(mintUrl: mintURL) else { return }

        try await repository.createWallet(mintUrl: mintURL, unit: .sat, targetProofCount: 24)
        let wallet = try await repository.getWallet(mintUrl: mintURL, unit: .sat)
        _ = try await wallet.fetchActiveKeyset()
        _ = try? await wallet.fetchMintInfo()
    }

    public func removeMint(_ rawURL: String) async throws {
        let normalized = try Self.normalizedMintURL(rawURL)
        let mintURL = MintUrl(url: normalized)
        let wallet = try await repository.getWallet(mintUrl: mintURL, unit: .sat)
        let total = try await wallet.totalBalance().value
            + wallet.totalPendingBalance().value
            + wallet.totalReservedBalance().value
        guard total == 0 else { throw CashuWalletError.mintHasFunds }
        try await repository.removeWallet(mintUrl: mintURL, currencyUnit: .sat)
    }

    public func recoverInterruptedOperations() async {
        let wallets = await repository.getWallets()
        for wallet in wallets where wallet.unit() == .sat {
            let mintURL = wallet.mintUrl().url
            let pendingRequestArtifacts = paymentArtifacts.filter {
                $0.mintURL == mintURL
                    && $0.direction == .incoming
                    && $0.kind == .ecash
                    && $0.valueKind == .cashuPaymentRequest
                    && $0.state == .pending
            }
            let recovery = try? await wallet.recoverIncompleteSagas()
            await reconcileIncomingPaymentRequestTransactions(wallet: wallet)

            if (recovery?.recovered ?? 0) > 0 {
                for artifact in pendingRequestArtifacts.prefix(Int(recovery?.recovered ?? 0)) {
                    guard paymentArtifacts.contains(where: {
                        $0.id == artifact.id && $0.state == .pending
                    }) else { continue }
                    try? upsertPaymentArtifact(
                        CashuPaymentArtifactRecord(
                            id: artifact.id,
                            operationID: artifact.operationID,
                            mintURL: artifact.mintURL,
                            direction: .incoming,
                            kind: .ecash,
                            value: artifact.value,
                            valueKind: .cashuPaymentRequest,
                            amount: artifact.amount,
                            memo: artifact.memo,
                            createdAt: artifact.createdAt,
                            state: .completed,
                            lastCheckedAt: Date()
                        )
                    )
                }
            }

            await repairLegacyInterruptedPaymentRequestIfNeeded(wallet: wallet)
            _ = try? await wallet.checkAllPendingProofs()
        }
        try? reconcileCreatedPaymentRequestsFromArtifacts()
        await refreshPendingLightningPayments(force: true)
        await refreshOutgoingTokenStates(force: true)
    }

    private func reconcileIncomingPaymentRequestTransactions(wallet: Wallet) async {
        guard let transactions = try? await wallet.listTransactions(direction: .incoming) else {
            return
        }
        for transaction in transactions where
            transaction.metadata["source"] == "taskify-native-payment-request" {
            guard let requestID = transaction.metadata["payment_request_id"]?.lowercased(),
                  let eventID = transaction.metadata["nostr_event_id"]?.lowercased(),
                  let request = createdPaymentRequests.first(where: {
                      $0.requestID == requestID
                  }) else { continue }
            let operationID = Self.paymentRequestReceiveOperationID(for: eventID)
            try? upsertPaymentArtifact(
                CashuPaymentArtifactRecord(
                    id: operationID,
                    transactionID: transaction.id.hex,
                    operationID: operationID,
                    mintURL: transaction.mintUrl.url,
                    direction: .incoming,
                    kind: .ecash,
                    value: request.encoded,
                    valueKind: .cashuPaymentRequest,
                    amount: transaction.amount.value,
                    memo: transaction.memo ?? request.description,
                    createdAt: Date(timeIntervalSince1970: TimeInterval(transaction.timestamp)),
                    state: .completed,
                    lastCheckedAt: Date(),
                    feePaid: transaction.fee.value
                )
            )
        }
        try? reconcileCreatedPaymentRequestsFromArtifacts()
    }

    private func repairLegacyInterruptedPaymentRequestIfNeeded(wallet: Wallet) async {
        let mintURL = wallet.mintUrl().url
        let candidates = createdPaymentRequests.filter { request in
            request.receivedCount == 0
                && !request.processedEventIDs.isEmpty
                && request.mintURLs.contains(mintURL)
                && !paymentArtifacts.contains(where: {
                    $0.value == request.encoded
                        && $0.direction == .incoming
                        && $0.valueKind == .cashuPaymentRequest
                        && $0.state == .completed
                })
        }
        guard candidates.count == 1, let request = candidates.first else { return }

        let balanceBefore = (try? await wallet.totalBalance().value) ?? 0
        guard (try? await wallet.restore()) != nil else { return }
        let balanceAfter = (try? await wallet.totalBalance().value) ?? balanceBefore
        await reconcileIncomingPaymentRequestTransactions(wallet: wallet)
        guard !paymentArtifacts.contains(where: {
            $0.value == request.encoded
                && $0.direction == .incoming
                && $0.valueKind == .cashuPaymentRequest
                && $0.state == .completed
        }) else { return }

        let recoveredAmount: UInt64?
        if balanceAfter > balanceBefore {
            recoveredAmount = balanceAfter - balanceBefore
        } else {
            recoveredAmount = request.amount
        }
        guard let recoveredAmount, recoveredAmount > 0,
              let eventID = request.processedEventIDs.last else { return }
        let operationID = Self.paymentRequestReceiveOperationID(for: eventID)
        try? upsertPaymentArtifact(
            CashuPaymentArtifactRecord(
                id: operationID,
                operationID: operationID,
                mintURL: mintURL,
                direction: .incoming,
                kind: .ecash,
                value: request.encoded,
                valueKind: .cashuPaymentRequest,
                amount: recoveredAmount,
                memo: request.description,
                createdAt: request.lastReceivedAt ?? Date(),
                state: .completed,
                lastCheckedAt: Date()
            )
        )
        try? reconcileCreatedPaymentRequestsFromArtifacts()
    }

    public func refreshOutgoingTokenStates(
        force: Bool = false,
        at date: Date = Date()
    ) async {
        var checksByMint: [String: [OutgoingTokenProofCheck]] = [:]
        let candidates = outgoingTokens.filter { record in
            guard record.status == .ready || record.status == .partiallyRedeemed else {
                return false
            }
            if force { return true }
            guard let lastCheckedAt = record.lastCheckedAt else { return true }
            return date.timeIntervalSince(lastCheckedAt) >= 60
        }

        for record in candidates {
            guard
                let token = try? Token.decode(encodedToken: record.token),
                let proofs = try? token.proofsSimple(),
                !proofs.isEmpty
            else { continue }
            checksByMint[record.mintURL, default: []].append(
                OutgoingTokenProofCheck(id: record.id, proofs: proofs)
            )
        }

        var changed = false
        for (mintURL, checks) in checksByMint {
            let allProofs = checks.flatMap(\.proofs)
            guard let wallet = try? await repository.getWallet(
                mintUrl: MintUrl(url: mintURL),
                unit: .sat
            ) else { continue }
            guard let spentStates = try? await wallet.checkProofsSpent(proofs: allProofs),
                  spentStates.count == allProofs.count else {
                for check in checks {
                    if let index = outgoingTokens.firstIndex(where: { $0.id == check.id }) {
                        outgoingTokens[index].lastCheckedAt = date
                        changed = true
                    }
                }
                continue
            }

            var offset = 0
            for check in checks {
                let upperBound = offset + check.proofs.count
                let tokenStates = Array(spentStates[offset..<upperBound])
                offset = upperBound
                guard let index = outgoingTokens.firstIndex(where: { $0.id == check.id }) else {
                    continue
                }
                outgoingTokens[index].status = Self.outgoingTokenStatus(
                    for: tokenStates
                )
                outgoingTokens[index].lastCheckedAt = date
                outgoingTokens[index].spentProofCount = tokenStates.filter { $0 }.count
                outgoingTokens[index].proofCount = tokenStates.count
                changed = true
            }
        }
        if changed { try? persistOutgoingTokens() }
    }

    public func checkOutgoingTokenState(id: String) async throws -> CashuOutgoingToken {
        guard let record = outgoingTokens.first(where: { $0.id == id }) else {
            throw CashuWalletError.outgoingTokenMissing
        }
        guard record.status == .ready || record.status == .partiallyRedeemed else {
            return record
        }
        let token = try Token.decode(encodedToken: record.token)
        let proofs = try token.proofsSimple()
        let wallet = try await repository.getWallet(
            mintUrl: MintUrl(url: record.mintURL),
            unit: .sat
        )
        let spentStates = try await wallet.checkProofsSpent(proofs: proofs)
        guard spentStates.count == proofs.count,
              let index = outgoingTokens.firstIndex(where: { $0.id == id }) else {
            throw CashuWalletError.outgoingTokenMissing
        }
        outgoingTokens[index].status = Self.outgoingTokenStatus(for: spentStates)
        outgoingTokens[index].lastCheckedAt = Date()
        outgoingTokens[index].spentProofCount = spentStates.filter { $0 }.count
        outgoingTokens[index].proofCount = spentStates.count
        try persistOutgoingTokens()
        return outgoingTokens[index]
    }

    static func outgoingTokenStatus(for spentProofs: [Bool]) -> CashuOutgoingTokenStatus {
        guard !spentProofs.isEmpty else { return .ready }
        let spentCount = spentProofs.filter { $0 }.count
        if spentCount == 0 { return .ready }
        if spentCount == spentProofs.count { return .redeemed }
        return .partiallyRedeemed
    }

    public func refreshPendingLightningPayments(
        force: Bool = false,
        at date: Date = Date()
    ) async {
        let pendingQuoteIDs = paymentArtifacts.compactMap { artifact -> String? in
            guard
                artifact.kind == .lightning,
                artifact.direction == .outgoing,
                artifact.state == .pending,
                let quoteID = artifact.quoteID
            else { return nil }
            if !force,
               let lastCheckedAt = artifact.lastCheckedAt,
               date.timeIntervalSince(lastCheckedAt) < 15 {
                return nil
            }
            return quoteID
        }

        for quoteID in pendingQuoteIDs {
            guard let artifact = paymentArtifacts.first(where: {
                $0.quoteID == quoteID
                    && $0.direction == .outgoing
                    && $0.kind == .lightning
            }) else {
                continue
            }
            guard let wallet = try? await repository.getWallet(
                mintUrl: MintUrl(url: artifact.mintURL),
                unit: .sat
            ) else { continue }

            guard let quote = try? await wallet.checkMeltQuoteStatus(quoteId: quoteID) else {
                try? updateLightningPaymentArtifact(
                    quoteID: quoteID,
                    state: .pending,
                    lastCheckedAt: date
                )
                continue
            }

            switch quote.state {
            case .paid, .issued:
                _ = try? await wallet.recoverIncompleteSagas()
                let result = await recoveredLightningPaymentResult(
                    quote: quote,
                    wallet: wallet,
                    mintURL: artifact.mintURL
                )
                await recordLightningPaymentResult(result, wallet: wallet)
            case .pending:
                try? updateLightningPaymentArtifact(
                    quoteID: quoteID,
                    state: .pending,
                    lastCheckedAt: date,
                    paymentProof: quote.paymentProof
                )
            case .unpaid:
                try? updateLightningPaymentArtifact(
                    quoteID: quoteID,
                    state: .failed,
                    lastCheckedAt: date
                )
            }
        }
    }

    public func recoveryPhrase() -> String {
        mnemonic
    }

    public func seedBackupJSON() async throws -> String {
        let mintURLs = await repository.getWallets()
            .filter { $0.unit() == .sat }
            .map { $0.mintUrl().url }
        let counters = Dictionary(uniqueKeysWithValues: mintURLs.map { ($0, [String: Int]()) })
        let payload: [String: Any] = [
            "type": "nut13-wallet-backup",
            "version": 1,
            "mnemonic": mnemonic,
            "createdAt": ISO8601DateFormatter().string(from: Date()),
            "counters": counters,
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        guard let json = String(data: data, encoding: .utf8) else {
            throw CashuWalletError.invalidRecoveryBackup
        }
        return json
    }

    public func restoreMint(_ rawURL: String) async throws -> CashuMintRestoreSummary {
        let normalized = try Self.normalizedMintURL(rawURL)
        let mintURL = MintUrl(url: normalized)
        if await !repository.hasMint(mintUrl: mintURL) {
            try await repository.createWallet(mintUrl: mintURL, unit: .sat, targetProofCount: 24)
        }
        let wallet = try await repository.getWallet(mintUrl: mintURL, unit: .sat)
        let restored = try await wallet.restore()
        _ = try? await wallet.fetchMintInfo()
        return CashuMintRestoreSummary(
            mintURL: normalized,
            spent: restored.spent.value,
            unspent: restored.unspent.value,
            pending: restored.pending.value
        )
    }

    public func latestLightningReceiveQuote(
        mintURL rawMintURL: String? = nil,
        at date: Date = Date()
    ) throws -> CashuLightningReceiveQuote? {
        let normalizedMintURL = try rawMintURL.map(Self.normalizedMintURL)
        return try trackedLightningReceiveQuotes(at: date)
            .first {
                (normalizedMintURL == nil || $0.mintURL == normalizedMintURL)
                    && $0.isOutstanding(at: date)
            }
    }

    public func trackedLightningReceiveQuotes(
        at date: Date = Date()
    ) throws -> [CashuLightningReceiveQuote] {
        var changed = false
        for index in lightningReceiveQuotes.indices
        where lightningReceiveQuotes[index].isExpired(at: date) {
            lightningReceiveQuotes[index].state = .expired
            changed = true
        }
        if changed { try persistLightningReceiveQuotes() }
        return lightningReceiveQuotes.sorted { $0.createdAt > $1.createdAt }
    }

    public func createLightningReceiveQuote(
        mintURL rawMintURL: String,
        amount: UInt64
    ) async throws -> CashuLightningReceiveQuote {
        guard amount > 0 else { throw CashuWalletError.invalidLightningAmount }
        let normalized = try Self.normalizedMintURL(rawMintURL)
        let wallet = try await repository.getWallet(mintUrl: MintUrl(url: normalized), unit: .sat)
        let quote = try await wallet.mintQuote(
            paymentMethod: .bolt11,
            amount: Amount(value: amount),
            description: "Taskify wallet deposit",
            extra: nil
        )
        let record = lightningReceiveQuote(
            from: quote,
            fallbackAmount: amount,
            createdAt: Date()
        )
        try upsertLightningReceiveQuote(record)
        try upsertPaymentArtifact(
            CashuPaymentArtifactRecord(
                quoteID: record.id,
                mintURL: record.mintURL,
                direction: .incoming,
                kind: .lightning,
                value: record.invoice,
                valueKind: .lightningInvoice,
                amount: record.amount,
                createdAt: record.createdAt
            )
        )
        return record
    }

    public func checkAndClaimLightningReceiveQuote(
        id: String
    ) async throws -> CashuLightningReceiveQuote {
        guard let existing = lightningReceiveQuotes.first(where: { $0.id == id }) else {
            throw CashuWalletError.lightningQuoteMissing
        }
        guard !existing.isExpired() else {
            var expired = existing
            expired.state = .expired
            try upsertLightningReceiveQuote(expired)
            return expired
        }
        guard lightningQuoteChecksInFlight.insert(id).inserted else {
            return existing
        }
        defer { lightningQuoteChecksInFlight.remove(id) }

        let wallet = try await repository.getWallet(
            mintUrl: MintUrl(url: existing.mintURL),
            unit: .sat
        )
        let checked = try await wallet.checkMintQuote(quoteId: id)
        var record = lightningReceiveQuote(
            from: checked,
            fallbackAmount: existing.amount,
            createdAt: existing.createdAt
        )

        if record.state == .paid {
            do {
                let proofs = try await wallet.mintUnified(
                    quoteId: id,
                    amountSplitTarget: .none,
                    spendingConditions: nil
                )
                record.state = .issued
                record.issuedAmount = proofs.reduce(UInt64(0)) { $0 + $1.amount.value }
            } catch {
                // A crash can occur after the mint issued proofs but before the
                // local quote journal was updated. Treat an issued quote as a
                // successful recovery instead of attempting to mint twice.
                if let refreshed = try? await wallet.checkMintQuote(quoteId: id),
                   refreshed.state == .issued {
                    record = lightningReceiveQuote(
                        from: refreshed,
                        fallbackAmount: existing.amount,
                        createdAt: existing.createdAt
                    )
                } else {
                    throw error
                }
            }
        }

        try upsertLightningReceiveQuote(record)
        return record
    }

    @discardableResult
    public func recoverPendingLightningReceives() async -> [CashuLightningReceiveQuote] {
        let quoteIDs = lightningReceiveQuotes
            .filter { $0.isOutstanding() }
            .map(\.id)
        var checkedQuotes: [CashuLightningReceiveQuote] = []
        for quoteID in quoteIDs {
            if let quote = try? await checkAndClaimLightningReceiveQuote(id: quoteID) {
                checkedQuotes.append(quote)
            }
        }
        return checkedQuotes
    }

    public func prepareLightningPayment(
        mintURL rawMintURL: String,
        invoice rawInvoice: String,
        amount: UInt64? = nil
    ) async throws -> CashuLightningPaymentQuote {
        if let amount, amount == 0 { throw CashuWalletError.invalidLightningAmount }
        let normalizedMintURL = try Self.normalizedMintURL(rawMintURL)
        let invoice = try Self.normalizedLightningInvoice(rawInvoice)
        let wallet = try await repository.getWallet(
            mintUrl: MintUrl(url: normalizedMintURL),
            unit: .sat
        )

        let options: MeltOptions?
        if let amount {
            let (amountMsat, overflow) = amount.multipliedReportingOverflow(by: 1_000)
            guard !overflow else { throw CashuWalletError.invalidLightningAmount }
            options = .amountless(amountMsat: Amount(value: amountMsat))
        } else {
            options = nil
        }

        let meltQuote = try await wallet.meltQuote(
            method: .bolt11,
            request: invoice,
            options: options,
            extra: nil
        )
        guard meltQuote.unit == .sat else { throw CashuWalletError.unsupportedUnit }
        let expiresAt = meltQuote.expiry > 0
            ? Date(timeIntervalSince1970: TimeInterval(meltQuote.expiry))
            : nil
        if let expiresAt, expiresAt <= Date() { throw CashuWalletError.lightningInvoiceExpired }

        let prepared = try await wallet.prepareMelt(quoteId: meltQuote.id)
        let id = UUID()
        preparedLightningPayments[id] = PreparedLightningPaymentEntry(
            melt: prepared,
            wallet: wallet,
            mintURL: normalizedMintURL,
            invoice: invoice,
            quoteID: meltQuote.id,
            amount: meltQuote.amount.value
        )
        do {
            try upsertPaymentArtifact(
                CashuPaymentArtifactRecord(
                    quoteID: meltQuote.id,
                    mintURL: normalizedMintURL,
                    direction: .outgoing,
                    kind: .lightning,
                    value: invoice,
                    valueKind: .lightningInvoice,
                    amount: meltQuote.amount.value,
                    expiresAt: expiresAt
                )
            )
        } catch {
            preparedLightningPayments.removeValue(forKey: id)
            try? await prepared.cancel()
            throw error
        }
        return CashuLightningPaymentQuote(
            id: id,
            quoteID: meltQuote.id,
            mintURL: normalizedMintURL,
            invoice: invoice,
            amount: meltQuote.amount.value,
            feeReserve: meltQuote.feeReserve.value,
            walletFee: prepared.totalFee().value,
            expiresAt: expiresAt
        )
    }

    public func cancelLightningPayment(id: UUID) async {
        guard let entry = preparedLightningPayments.removeValue(forKey: id) else { return }
        try? await entry.melt.cancel()
        try? removePaymentArtifact(quoteID: entry.quoteID, direction: .outgoing)
    }

    public func confirmLightningPayment(id: UUID) async throws -> CashuLightningPaymentResult {
        guard let entry = preparedLightningPayments[id] else {
            throw CashuWalletError.lightningPaymentMissing
        }
        try updateLightningPaymentArtifact(
            quoteID: entry.quoteID,
            state: .pending,
            lastCheckedAt: Date()
        )
        preparedLightningPayments.removeValue(forKey: id)

        do {
            let finalized = try await entry.melt.confirm()
            let result = CashuLightningPaymentResult(
                quoteID: finalized.quoteId,
                mintURL: entry.mintURL,
                amount: finalized.amount.value,
                feePaid: finalized.state == .paid ? finalized.feePaid.value : nil,
                preimage: finalized.preimage,
                state: finalized.state == .pending ? .pending : .completed
            )
            await recordLightningPaymentResult(result, wallet: entry.wallet)
            return result
        } catch {
            // A connection can fail after the mint accepted the melt. Query the
            // quote before reporting failure so a successful payment is never
            // presented as safe to retry.
            if let checked = try? await entry.wallet.checkMeltQuoteStatus(quoteId: entry.quoteID),
               checked.state == .paid || checked.state == .pending {
                let result = await recoveredLightningPaymentResult(
                    quote: checked,
                    wallet: entry.wallet,
                    mintURL: entry.mintURL
                )
                await recordLightningPaymentResult(result, wallet: entry.wallet)
                return result
            }
            _ = try? await entry.wallet.recoverIncompleteSagas()
            if let checked = try? await entry.wallet.checkMeltQuoteStatus(quoteId: entry.quoteID) {
                if checked.state == .paid || checked.state == .pending {
                    let result = await recoveredLightningPaymentResult(
                        quote: checked,
                        wallet: entry.wallet,
                        mintURL: entry.mintURL
                    )
                    await recordLightningPaymentResult(result, wallet: entry.wallet)
                    return result
                }
                try? updateLightningPaymentArtifact(
                    quoteID: entry.quoteID,
                    state: .failed,
                    lastCheckedAt: Date()
                )
                throw error
            }
            throw CashuWalletError.lightningPaymentUncertain
        }
    }

    /// Moves balance between two configured Cashu mints by creating a
    /// destination mint quote and paying it from the source mint over
    /// Lightning. The destination quote is persisted before payment, so the
    /// normal foreground/background invoice monitor can finish claiming it if
    /// the app is suspended after the source mint pays.
    public func transferBetweenMints(
        amount: UInt64,
        from sourceMintURL: String,
        to destinationMintURL: String
    ) async throws -> CashuMintTransferResult {
        let normalizedSource = try Self.normalizedMintURL(sourceMintURL)
        let sourceWallet = try await repository.getWallet(
            mintUrl: MintUrl(url: normalizedSource),
            unit: .sat
        )
        let available = try await sourceWallet.totalBalance().value
        let mints = try Self.validateMintTransfer(
            amount: amount,
            sourceMintURL: normalizedSource,
            destinationMintURL: destinationMintURL,
            available: available
        )

        guard await repository.hasMint(mintUrl: MintUrl(url: mints.destination)) else {
            throw CashuWalletError.invalidMintURL
        }

        let receiveQuote = try await createLightningReceiveQuote(
            mintURL: mints.destination,
            amount: amount
        )
        var preparedPayment: CashuLightningPaymentQuote?
        var confirmationStarted = false

        do {
            let paymentQuote = try await prepareLightningPayment(
                mintURL: mints.source,
                invoice: receiveQuote.invoice
            )
            preparedPayment = paymentQuote
            guard paymentQuote.maximumTotal <= available else {
                await cancelLightningPayment(id: paymentQuote.id)
                preparedPayment = nil
                try? discardUnpaidLightningReceiveQuote(id: receiveQuote.id)
                throw CashuWalletError.mintTransferInsufficientBalance
            }

            confirmationStarted = true
            let payment = try await confirmLightningPayment(id: paymentQuote.id)
            preparedPayment = nil
            guard payment.state == .completed else {
                return CashuMintTransferResult(
                    sourceMintURL: mints.source,
                    destinationMintURL: mints.destination,
                    amount: amount,
                    receivedAmount: 0,
                    feePaid: payment.feePaid,
                    receiveQuoteID: receiveQuote.id,
                    paymentQuoteID: payment.quoteID,
                    state: .pending
                )
            }

            for attempt in 0..<10 {
                if let checked = try? await checkAndClaimLightningReceiveQuote(id: receiveQuote.id),
                   checked.state == .issued {
                    return CashuMintTransferResult(
                        sourceMintURL: mints.source,
                        destinationMintURL: mints.destination,
                        amount: amount,
                        receivedAmount: checked.issuedAmount > 0 ? checked.issuedAmount : amount,
                        feePaid: payment.feePaid,
                        receiveQuoteID: receiveQuote.id,
                        paymentQuoteID: payment.quoteID,
                        state: .completed
                    )
                }
                if attempt < 9 {
                    try? await Task.sleep(for: .seconds(2))
                }
            }

            return CashuMintTransferResult(
                sourceMintURL: mints.source,
                destinationMintURL: mints.destination,
                amount: amount,
                receivedAmount: 0,
                feePaid: payment.feePaid,
                receiveQuoteID: receiveQuote.id,
                paymentQuoteID: payment.quoteID,
                state: .pending
            )
        } catch {
            if let preparedPayment, !confirmationStarted {
                await cancelLightningPayment(id: preparedPayment.id)
            }
            if !confirmationStarted {
                try? discardUnpaidLightningReceiveQuote(id: receiveQuote.id)
            }
            throw error
        }
    }

    private func recoveredLightningPaymentResult(
        quote: MeltQuote,
        wallet: Wallet,
        mintURL: String
    ) async -> CashuLightningPaymentResult {
        let transactions = try? await wallet.listTransactions(direction: .outgoing)
        let transaction = transactions?.first { $0.quoteId == quote.id }
        return CashuLightningPaymentResult(
            quoteID: quote.id,
            mintURL: mintURL,
            amount: quote.amount.value,
            feePaid: transaction?.fee.value,
            preimage: transaction?.paymentProof ?? quote.paymentProof,
            state: quote.state == .paid || quote.state == .issued ? .completed : .pending
        )
    }

    /// Reissues every currently spendable proof for a restored mint into another
    /// wallet without changing either wallet's seed. The receiving wallet pays
    /// the mint's normal input fee, so `deposited` can be lower than `recovered`.
    public func transferRestoredBalance(
        fromMint rawURL: String,
        into destination: CashuWalletService
    ) async throws -> CashuMintTransferSummary {
        let normalized = try Self.normalizedMintURL(rawURL)
        let wallet = try await repository.getWallet(mintUrl: MintUrl(url: normalized), unit: .sat)
        let recovered = try await wallet.totalBalance().value
        let pending = try await wallet.totalPendingBalance().value
        guard recovered > 0 else {
            return CashuMintTransferSummary(
                mintURL: normalized,
                recovered: 0,
                deposited: 0,
                pending: pending
            )
        }

        // `includeFee: false` is intentional for a wallet-to-wallet sweep: the
        // token carries the source wallet's full balance and the destination
        // receives the remainder after the mint's input fee.
        let prepared = try await wallet.prepareSend(
            amount: Amount(value: recovered),
            options: SendOptions(
                memo: nil,
                conditions: nil,
                amountSplitTarget: .none,
                sendKind: .onlineExact,
                includeFee: false,
                useP2bk: false,
                maxProofs: nil,
                metadata: ["source": "taskify-seed-transfer"],
                p2pkSigningKeys: [],
                p2pkLockedProofSendMode: .swap
            )
        )
        let operationID = prepared.operationId()
        let token: Token
        do {
            token = try await prepared.confirm(memo: "Taskify seed transfer")
        } catch {
            try? await prepared.cancel()
            throw error
        }

        do {
            let deposited = try await destination.receive(token.encode())
            _ = try? await wallet.checkAllPendingProofs()
            return CashuMintTransferSummary(
                mintURL: normalized,
                recovered: recovered,
                deposited: deposited,
                pending: pending
            )
        } catch {
            // If receiving failed before the token was spent, release its source
            // proofs. If the mint did spend it, CDK's destination saga can still
            // recover the new outputs on the next wallet start.
            _ = try? await wallet.revokeSend(operationId: operationID)
            throw error
        }
    }

    public static func pendingReceiveFingerprint(_ encodedToken: String) -> String {
        let normalized = encodedToken.trimmingCharacters(in: .whitespacesAndNewlines)
        let digest = SHA256.hash(data: Data(normalized.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    public func savedCreatedPaymentRequests() -> [CashuCreatedPaymentRequest] {
        createdPaymentRequests.sorted { $0.createdAt > $1.createdAt }
    }

    @discardableResult
    public func createNostrPaymentRequest(
        amount: UInt64?,
        description: String?,
        mintURLs: [String],
        recipientPublicKey: String,
        relayURLs: [String],
        singleUse: Bool
    ) throws -> CashuCreatedPaymentRequest {
        let request = try CashuPaymentRequestContract.createNostrRequest(
            amount: amount,
            description: description,
            mintURLs: mintURLs,
            recipientPublicKey: recipientPublicKey,
            relayURLs: relayURLs,
            singleUse: singleUse
        )
        createdPaymentRequests.removeAll { $0.requestID == request.requestID }
        createdPaymentRequests.append(request)
        try persistCreatedPaymentRequests()
        return request
    }

    public func cancelCreatedPaymentRequest(id: String) throws {
        guard let index = createdPaymentRequests.firstIndex(where: { $0.requestID == id }) else {
            throw CashuWalletError.paymentRequestNotFound
        }
        createdPaymentRequests[index].state = .cancelled
        try persistCreatedPaymentRequests()
    }

    @discardableResult
    public func receiveNostrPayment(
        _ delivery: CashuNostrPaymentDelivery
    ) async throws -> CashuPaymentRequestReceipt {
        let payload = try PaymentRequestPayload.fromString(json: delivery.payloadJSON)
        let encodedToken = try CashuPaymentRequestContract.tokenString(
            fromPaymentPayload: delivery.payloadJSON
        )
        let token: Token
        do {
            token = try Token.decode(encodedToken: encodedToken)
        } catch {
            throw CashuWalletError.invalidPaymentRequest
        }
        guard payload.unit() == .sat,
              let requestID = payload.id()?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased(),
              !requestID.isEmpty else {
            throw CashuWalletError.invalidPaymentRequest
        }
        guard let requestIndex = createdPaymentRequests.firstIndex(where: {
            $0.requestID == requestID
        }) else {
            throw CashuWalletError.paymentRequestNotFound
        }
        let request = createdPaymentRequests[requestIndex]

        let proofs = payload.proofs()
        let amount = proofs.reduce(UInt64(0)) { partial, proof in
            let next = partial.addingReportingOverflow(proof.amount.value)
            return next.overflow ? UInt64.max : next.partialValue
        }
        guard amount > 0, amount != .max else {
            throw CashuWalletError.invalidPaymentRequest
        }
        if let expected = request.amount, expected != amount {
            throw CashuWalletError.paymentRequestAmountMismatch
        }

        let mintURL = try Self.normalizedMintURL(payload.mint().url)
        guard request.mintURLs.contains(where: {
            (try? Self.normalizedMintURL($0)) == mintURL
        }) else {
            throw CashuWalletError.paymentRequestMintUnavailable
        }
        let mint = MintUrl(url: mintURL)
        if await !repository.hasMint(mintUrl: mint) {
            try await repository.createWallet(mintUrl: mint, unit: .sat, targetProofCount: 24)
        }
        let wallet = try await repository.getWallet(mintUrl: mint, unit: .sat)
        let artifactID = Self.paymentRequestReceiveOperationID(for: delivery.eventID)
        if let existingIndex = paymentArtifacts.firstIndex(where: {
            $0.operationID == artifactID && $0.state == .completed
        }) {
            if paymentArtifacts[existingIndex].cashuToken == nil {
                paymentArtifacts[existingIndex].cashuToken = encodedToken
                try persistPaymentArtifacts()
            }
            throw CashuWalletError.paymentRequestAlreadyProcessed
        }
        if completedIncomingArtifact(for: encodedToken) != nil {
            throw CashuWalletError.paymentRequestAlreadyProcessed
        }

        let payloadMemo = payload.memo()?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let memo = payloadMemo?.isEmpty == false ? payloadMemo : request.description
        let options = ReceiveOptions(
            amountSplitTarget: .none,
            p2pkSigningKeys: [],
            preimages: [],
            metadata: [
                "source": "taskify-native-payment-request",
                "payment_request_id": requestID,
                "nostr_event_id": delivery.eventID,
            ]
        )

        if let transaction = await incomingPaymentRequestTransaction(
            wallet: wallet,
            eventID: delivery.eventID
        ) {
            return try finalizeNostrPayment(
                delivery: delivery,
                request: request,
                mintURL: mintURL,
                amount: transaction.amount.value,
                memo: memo,
                cashuToken: encodedToken,
                transaction: transaction
            )
        }

        // Request state controls whether the QR remains advertised; it must not
        // be used to discard bearer ecash that a payer already sent. This is
        // especially important when two payments are in flight before a
        // single-use request's first delivery is processed. Event/artifact
        // de-duplication below still prevents the same delivery being credited
        // twice.

        try upsertPaymentArtifact(
            CashuPaymentArtifactRecord(
                id: artifactID,
                operationID: artifactID,
                mintURL: mintURL,
                direction: .incoming,
                kind: .ecash,
                value: request.encoded,
                valueKind: .cashuPaymentRequest,
                cashuToken: encodedToken,
                amount: amount,
                memo: memo,
                createdAt: delivery.receivedAt,
                state: .pending,
                lastCheckedAt: Date()
            )
        )

        if request.processedEventIDs.contains(delivery.eventID) {
            let balanceBefore = (try? await wallet.totalBalance().value) ?? 0
            let recovery = try? await wallet.recoverIncompleteSagas()
            let balanceAfter = (try? await wallet.totalBalance().value) ?? balanceBefore
            if let transaction = await incomingPaymentRequestTransaction(
                wallet: wallet,
                eventID: delivery.eventID
            ) {
                return try finalizeNostrPayment(
                    delivery: delivery,
                    request: request,
                    mintURL: mintURL,
                    amount: transaction.amount.value,
                    memo: memo,
                    cashuToken: encodedToken,
                    transaction: transaction
                )
            }
            if recovery?.recovered ?? 0 > 0 || balanceAfter > balanceBefore {
                let recoveredAmount = balanceAfter > balanceBefore
                    ? balanceAfter - balanceBefore
                    : amount
                return try finalizeNostrPayment(
                    delivery: delivery,
                    request: request,
                    mintURL: mintURL,
                    amount: recoveredAmount,
                    memo: memo,
                    cashuToken: encodedToken,
                    transaction: nil
                )
            }
        }

        var lastError: Error?
        var attemptedCounterRecovery = false
        for attempt in 0..<4 {
            let transactionIDsBefore = try? await transactionIDs(
                wallet: wallet,
                direction: .incoming
            )
            do {
                // Match CDK's official wallet implementation: rebuild the full
                // token from the NUT-18 payload and use the normal receive path.
                // Going straight to receiveProofs bypassed token/keyset handling
                // and left less information for transaction and saga recovery.
                let received = try await wallet.receive(
                    token: token,
                    options: options
                ).value
                let transaction = await newTransaction(
                    wallet: wallet,
                    direction: .incoming,
                    knownIDs: transactionIDsBefore,
                    expectedAmount: received
                )
                return try finalizeNostrPayment(
                    delivery: delivery,
                    request: request,
                    mintURL: mintURL,
                    amount: received,
                    memo: memo,
                    cashuToken: encodedToken,
                    transaction: transaction
                )
            } catch {
                lastError = error
                let message = String(describing: error)
                if Self.isTokenAlreadySpentMessage(message) {
                    let balanceBefore = (try? await wallet.totalBalance().value) ?? 0
                    let recovery = try? await wallet.recoverIncompleteSagas()
                    let balanceAfter = (try? await wallet.totalBalance().value) ?? balanceBefore
                    if let transaction = await incomingPaymentRequestTransaction(
                        wallet: wallet,
                        eventID: delivery.eventID
                    ) {
                        return try finalizeNostrPayment(
                            delivery: delivery,
                            request: request,
                            mintURL: mintURL,
                            amount: transaction.amount.value,
                            memo: memo,
                            cashuToken: encodedToken,
                            transaction: transaction
                        )
                    }
                    if recovery?.recovered ?? 0 > 0 || balanceAfter > balanceBefore {
                        let recoveredAmount = balanceAfter > balanceBefore
                            ? balanceAfter - balanceBefore
                            : amount
                        return try finalizeNostrPayment(
                            delivery: delivery,
                            request: request,
                            mintURL: mintURL,
                            amount: recoveredAmount,
                            memo: memo,
                            cashuToken: encodedToken,
                            transaction: nil
                        )
                    }
                    throw CashuWalletError.paymentRequestUncertain
                }
                guard Self.isCounterDesynchronizationMessage(message), attempt < 3 else {
                    throw error
                }
                if !attemptedCounterRecovery {
                    attemptedCounterRecovery = true
                    _ = try? await wallet.restore()
                }
            }
        }
        throw lastError ?? CashuWalletError.invalidPaymentRequest
    }

    public func savedPendingReceives() -> [CashuPendingReceive] {
        pendingReceives.sorted { $0.createdAt > $1.createdAt }
    }

    public func submitReceive(_ encodedToken: String) async throws -> CashuReceiveSubmissionResult {
        let trimmed = encodedToken.trimmingCharacters(in: .whitespacesAndNewlines)
        let preview = try await previewToken(trimmed)
        let id = Self.pendingReceiveFingerprint(trimmed)

        if let artifact = completedIncomingArtifact(for: trimmed) {
            pendingReceives.removeAll { $0.id == id }
            try persistPendingReceives()
            return .alreadyReceived(artifact.amount ?? preview.receivedAmount)
        }

        if !pendingReceives.contains(where: { $0.id == id }) {
            pendingReceives.append(
                CashuPendingReceive(
                    id: id,
                    token: trimmed,
                    mintURL: preview.mintURL,
                    amount: preview.amount,
                    memo: preview.memo,
                    createdAt: Date()
                )
            )
            try persistPendingReceives()
        }

        do {
            return .received(try await redeemPendingReceive(id: id))
        } catch CashuWalletError.pendingReceiveAlreadySpent {
            throw CashuWalletError.pendingReceiveAlreadySpent
        } catch {
            guard let pending = pendingReceives.first(where: { $0.id == id }) else {
                throw error
            }
            return .queued(pending)
        }
    }

    @discardableResult
    public func redeemPendingReceive(id: String) async throws -> UInt64 {
        guard let index = pendingReceives.firstIndex(where: { $0.id == id }) else {
            throw CashuWalletError.pendingReceiveMissing
        }
        guard pendingReceiveIDsInFlight.insert(id).inserted else {
            throw CashuWalletError.pendingReceiveInProgress
        }
        defer { pendingReceiveIDsInFlight.remove(id) }

        let pending = pendingReceives[index]
        if let artifact = completedIncomingArtifact(for: pending.token) {
            pendingReceives.removeAll { $0.id == id }
            try persistPendingReceives()
            return artifact.amount ?? pending.amount
        }

        pendingReceives[index].state = .queued
        pendingReceives[index].attemptCount += 1
        pendingReceives[index].lastAttemptAt = Date()
        pendingReceives[index].lastError = nil
        try persistPendingReceives()

        do {
            let received = try await receive(pending.token)
            pendingReceives.removeAll { $0.id == id }
            try persistPendingReceives()
            return received
        } catch {
            if let artifact = completedIncomingArtifact(for: pending.token) {
                pendingReceives.removeAll { $0.id == id }
                try persistPendingReceives()
                return artifact.amount ?? pending.amount
            }

            let message = String(describing: error)
            if Self.isTokenAlreadySpentMessage(message) {
                pendingReceives.removeAll { $0.id == id }
                try persistPendingReceives()
                throw CashuWalletError.pendingReceiveAlreadySpent
            }

            guard let failedIndex = pendingReceives.firstIndex(where: { $0.id == id }) else {
                throw error
            }
            pendingReceives[failedIndex].lastError = message
            pendingReceives[failedIndex].state = .queued
            try persistPendingReceives()
            throw error
        }
    }

    @discardableResult
    public func recoverPendingReceives(
        force: Bool = false,
        at date: Date = Date()
    ) async -> [CashuRecoveredReceive] {
        let retryCutoff = date.addingTimeInterval(-30)
        let candidates = pendingReceives
            .filter { pending in
                guard pending.isRecoverable else { return false }
                guard !pendingReceiveIDsInFlight.contains(pending.id) else { return false }
                return force || pending.lastAttemptAt == nil || pending.lastAttemptAt! <= retryCutoff
            }
            .sorted { $0.createdAt < $1.createdAt }
        var recovered: [CashuRecoveredReceive] = []
        for pending in candidates {
            if let amount = try? await redeemPendingReceive(id: pending.id) {
                recovered.append(
                    CashuRecoveredReceive(pending: pending, receivedAmount: amount)
                )
            }
        }
        return recovered
    }

    public func discardPendingReceive(id: String) throws {
        guard !pendingReceiveIDsInFlight.contains(id) else {
            throw CashuWalletError.pendingReceiveInProgress
        }
        pendingReceives.removeAll { $0.id == id }
        try persistPendingReceives()
    }

    /// Decodes just the amount/mint/memo embedded in a token, with no network access — enough to
    /// label a chat bubble before the user opts into the full preview-and-receive flow.
    public static func offlineTokenSummary(_ encodedToken: String) -> CashuOfflineTokenSummary? {
        guard let token = try? Token.decode(
            encodedToken: encodedToken.trimmingCharacters(in: .whitespacesAndNewlines)
        ), token.unit() == nil || token.unit() == .sat,
        let mintURL = try? token.mintUrl().url,
        let amount = try? token.value().value else { return nil }
        return CashuOfflineTokenSummary(mintURL: mintURL, amount: amount, memo: token.memo())
    }

    public func previewToken(_ encodedToken: String) async throws -> CashuTokenPreview {
        let token = try Token.decode(encodedToken: encodedToken.trimmingCharacters(in: .whitespacesAndNewlines))
        guard token.unit() == nil || token.unit() == .sat else { throw CashuWalletError.unsupportedUnit }

        let mintURL = try token.mintUrl().url
        let amount = try token.value().value
        var fee: UInt64?
        if await repository.hasMint(mintUrl: MintUrl(url: mintURL)),
           let data = try? await repository.getTokenData(token: token) {
            fee = data.redeemFee?.value
        }

        return CashuTokenPreview(mintURL: mintURL, amount: amount, fee: fee, memo: token.memo())
    }

    public func payPaymentRequest(
        _ rawValue: String,
        mintURL rawMintURL: String,
        customAmount: UInt64?
    ) async throws -> CashuPaymentRequestPaymentResult {
        let preview = try Self.previewPaymentRequest(rawValue)
        guard !preview.transports.isEmpty else {
            throw CashuWalletError.paymentRequestTransportUnavailable
        }
        let amount = preview.amount ?? customAmount
        guard let amount, amount > 0 else {
            throw CashuWalletError.paymentRequestAmountRequired
        }

        let mintURL = try Self.normalizedMintURL(rawMintURL)
        guard Self.paymentRequestAcceptsMint(preview, mintURL: mintURL) else {
            throw CashuWalletError.paymentRequestMintUnavailable
        }

        let wallet = try await repository.getWallet(
            mintUrl: MintUrl(url: mintURL),
            unit: .sat
        )
        guard try await wallet.totalBalance().value >= amount else {
            throw CashuWalletError.paymentRequestInsufficientBalance
        }

        let request: PaymentRequest
        do {
            request = try PaymentRequest.fromString(encoded: preview.encoded)
        } catch {
            throw CashuWalletError.invalidPaymentRequest
        }
        let knownTransactionIDs = try await transactionIDs(
            wallet: wallet,
            direction: .outgoing
        )
        let artifactID = UUID().uuidString
        let createdAt = Date()
        try upsertPaymentArtifact(
            CashuPaymentArtifactRecord(
                id: artifactID,
                mintURL: mintURL,
                direction: .outgoing,
                kind: .ecash,
                value: preview.encoded,
                valueKind: .cashuPaymentRequest,
                amount: amount,
                memo: preview.description,
                createdAt: createdAt,
                state: .pending
            )
        )

        do {
            try await wallet.payRequest(
                paymentRequest: request,
                customAmount: preview.amount == nil ? Amount(value: amount) : nil
            )
            let transaction = await newTransaction(
                wallet: wallet,
                direction: .outgoing,
                knownIDs: knownTransactionIDs,
                expectedAmount: amount
            )
            let sentToken = await cashuToken(
                for: transaction,
                wallet: wallet
            )
            try upsertPaymentArtifact(
                CashuPaymentArtifactRecord(
                    id: artifactID,
                    transactionID: transaction?.id.hex,
                    operationID: transaction?.sagaId,
                    mintURL: mintURL,
                    direction: .outgoing,
                    kind: .ecash,
                    value: preview.encoded,
                    valueKind: .cashuPaymentRequest,
                    cashuToken: sentToken,
                    amount: amount,
                    memo: preview.description,
                    createdAt: createdAt,
                    state: .completed,
                    lastCheckedAt: Date(),
                    feePaid: transaction?.fee.value
                )
            )
            return CashuPaymentRequestPaymentResult(
                transactionID: transaction?.id.hex,
                mintURL: mintURL,
                amount: amount,
                paymentID: preview.paymentID
            )
        } catch {
            _ = try? await wallet.recoverIncompleteSagas()
            let transaction = await newTransaction(
                wallet: wallet,
                direction: .outgoing,
                knownIDs: knownTransactionIDs,
                expectedAmount: amount
            )
            if let transaction {
                let sentToken = await cashuToken(
                    for: transaction,
                    wallet: wallet
                )
                try? upsertPaymentArtifact(
                    CashuPaymentArtifactRecord(
                        id: artifactID,
                        transactionID: transaction.id.hex,
                        operationID: transaction.sagaId,
                        mintURL: mintURL,
                        direction: .outgoing,
                        kind: .ecash,
                        value: preview.encoded,
                        valueKind: .cashuPaymentRequest,
                        cashuToken: sentToken,
                        amount: amount,
                        memo: preview.description,
                        createdAt: createdAt,
                        state: .pending,
                        lastCheckedAt: Date(),
                        feePaid: transaction.fee.value
                    )
                )
                throw CashuWalletError.paymentRequestUncertain
            }
            try? removePaymentArtifact(id: artifactID)
            throw error
        }
    }

    @discardableResult
    public func receive(_ encodedToken: String) async throws -> UInt64 {
        let trimmed = encodedToken.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = try Token.decode(encodedToken: trimmed)
        guard token.unit() == nil || token.unit() == .sat else { throw CashuWalletError.unsupportedUnit }

        let mintURL = try token.mintUrl()
        if await !repository.hasMint(mintUrl: mintURL) {
            try await repository.createWallet(mintUrl: mintURL, unit: .sat, targetProofCount: 24)
        }
        let options = ReceiveOptions(
            amountSplitTarget: .none,
            p2pkSigningKeys: [],
            preimages: [],
            metadata: ["source": "taskify-native"]
        )

        // NUT-13 derives swap outputs from a persisted keyset counter. A wallet
        // restored from the same seed can occasionally lag the mint's counter,
        // which mints describe as either duplicate or already-signed outputs.
        // A one-time restore advances that counter without consuming the token;
        // fresh wallet handles then retry the receive with new outputs.
        var lastError: Error?
        var attemptedCounterRecovery = false
        for attempt in 0..<4 {
            let wallet = try await repository.getWallet(mintUrl: mintURL, unit: .sat)
            let transactionIDsBefore = try? await transactionIDs(
                wallet: wallet,
                direction: .incoming
            )
            do {
                let received = try await wallet.receive(token: token, options: options).value
                let transaction = await newTransaction(
                    wallet: wallet,
                    direction: .incoming,
                    knownIDs: transactionIDsBefore,
                    expectedAmount: received
                )
                try? upsertPaymentArtifact(
                    CashuPaymentArtifactRecord(
                        transactionID: transaction?.id.hex,
                        mintURL: mintURL.url,
                        direction: .incoming,
                        kind: .ecash,
                        value: trimmed,
                        valueKind: .cashuToken,
                        amount: received
                    )
                )
                return received
            } catch {
                lastError = error
                guard
                    Self.isCounterDesynchronizationMessage(String(describing: error)),
                    attempt < 3
                else {
                    throw error
                }

                if !attemptedCounterRecovery {
                    attemptedCounterRecovery = true
                    _ = try? await wallet.restore()
                }
            }
        }
        throw lastError ?? CashuWalletError.outgoingTokenMissing
    }

    public func prepareSend(
        mintURL rawMintURL: String,
        amount: UInt64
    ) async throws -> CashuPreparedSendQuote {
        let normalized = try Self.normalizedMintURL(rawMintURL)
        let wallet = try await repository.getWallet(mintUrl: MintUrl(url: normalized), unit: .sat)
        let prepared = try await wallet.prepareSend(
            amount: Amount(value: amount),
            options: SendOptions(
                memo: nil,
                conditions: nil,
                amountSplitTarget: .none,
                sendKind: .onlineExact,
                includeFee: false,
                useP2bk: false,
                maxProofs: 32,
                metadata: ["source": "taskify-native"],
                p2pkSigningKeys: [],
                p2pkLockedProofSendMode: .swap
            )
        )
        let id = UUID()
        preparedSends[id] = PreparedSendEntry(send: prepared, wallet: wallet, mintURL: normalized)
        return CashuPreparedSendQuote(
            id: id,
            mintURL: normalized,
            amount: prepared.amount().value,
            fee: prepared.fee().value
        )
    }

    public func cancelPreparedSend(id: UUID) async {
        guard let entry = preparedSends.removeValue(forKey: id) else { return }
        try? await entry.send.cancel()
    }

    public func confirmPreparedSend(id: UUID, memo: String?) async throws -> CashuOutgoingToken {
        guard let entry = preparedSends[id] else { throw CashuWalletError.preparedSendMissing }
        let normalizedMemo = memo?.trimmingCharacters(in: .whitespacesAndNewlines)
        let finalMemo = normalizedMemo?.isEmpty == false ? normalizedMemo : nil
        let token = try await entry.send.confirm(memo: finalMemo)
        let outgoing = CashuOutgoingToken(
            id: UUID().uuidString,
            operationID: entry.send.operationId(),
            mintURL: entry.mintURL,
            amount: entry.send.amount().value,
            fee: entry.send.fee().value,
            token: token.encode(),
            memo: finalMemo,
            createdAt: Date(),
            status: .ready
        )

        preparedSends.removeValue(forKey: id)
        outgoingTokens.append(outgoing)
        do {
            try persistOutgoingTokens()
        } catch {
            outgoingTokens.removeAll { $0.id == outgoing.id }
            _ = try? await entry.wallet.revokeSend(operationId: outgoing.operationID)
            throw error
        }
        let transaction = await newTransaction(
            wallet: entry.wallet,
            direction: .outgoing,
            operationID: outgoing.operationID,
            expectedAmount: outgoing.amount
        )
        try? upsertPaymentArtifact(
            CashuPaymentArtifactRecord(
                transactionID: transaction?.id.hex,
                operationID: outgoing.operationID,
                mintURL: outgoing.mintURL,
                direction: .outgoing,
                kind: .ecash,
                value: outgoing.token,
                valueKind: .cashuToken,
                amount: outgoing.amount,
                createdAt: outgoing.createdAt
            )
        )
        return outgoing
    }

    @discardableResult
    public func reclaimOutgoingToken(id: String) async throws -> UInt64 {
        let checked = try await checkOutgoingTokenState(id: id)
        guard checked.status != .redeemed else {
            throw CashuWalletError.outgoingTokenRedeemed
        }
        guard let index = outgoingTokens.firstIndex(where: { $0.id == id }) else {
            throw CashuWalletError.outgoingTokenMissing
        }
        let record = outgoingTokens[index]
        guard record.status == .ready || record.status == .partiallyRedeemed else { return 0 }

        let wallet = try await repository.getWallet(
            mintUrl: MintUrl(url: record.mintURL),
            unit: .sat
        )
        let reclaimed = try await wallet.revokeSend(operationId: record.operationID).value
        outgoingTokens[index].status = .reclaimed
        try persistOutgoingTokens()
        return reclaimed
    }

    private func persistOutgoingTokens() throws {
        let directory = outgoingTokensURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(outgoingTokens)
#if os(iOS)
        try data.write(
            to: outgoingTokensURL,
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
#else
        try data.write(to: outgoingTokensURL, options: .atomic)
#endif
    }

    private static func loadOutgoingTokens(from url: URL) -> [CashuOutgoingToken] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([CashuOutgoingToken].self, from: data)) ?? []
    }

    private func persistPendingReceives() throws {
        pendingReceives.sort { $0.createdAt > $1.createdAt }
        try Self.persistPendingReceives(pendingReceives, to: pendingReceivesURL)
    }

    private static func persistPendingReceives(
        _ pendingReceives: [CashuPendingReceive],
        to url: URL
    ) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(pendingReceives)
#if os(iOS)
        try data.write(
            to: url,
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
#else
        try data.write(to: url, options: .atomic)
#endif
    }

    static func loadPendingReceives(from url: URL) -> [CashuPendingReceive] {
        guard let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode([CashuPendingReceive].self, from: data)
        else { return [] }

        var seen = Set<String>()
        let recoverable = decoded
            .sorted { $0.createdAt > $1.createdAt }
            .filter { seen.insert($0.id).inserted }
            .filter(\.isRecoverable)
        if recoverable.count != decoded.count {
            try? persistPendingReceives(recoverable, to: url)
        }
        return recoverable
    }

    private func persistCreatedPaymentRequests() throws {
        let directory = createdPaymentRequestsURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        createdPaymentRequests.sort { $0.createdAt > $1.createdAt }
        let data = try JSONEncoder().encode(createdPaymentRequests)
#if os(iOS)
        try data.write(
            to: createdPaymentRequestsURL,
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
#else
        try data.write(to: createdPaymentRequestsURL, options: .atomic)
#endif
    }

    static func loadCreatedPaymentRequests(from url: URL) -> [CashuCreatedPaymentRequest] {
        guard let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode(
                [CashuCreatedPaymentRequest].self,
                from: data
              ) else { return [] }
        var seen = Set<String>()
        return decoded
            .sorted { $0.createdAt > $1.createdAt }
            .filter { seen.insert($0.requestID).inserted }
    }

    private func completedIncomingArtifact(for token: String) -> CashuPaymentArtifactRecord? {
        paymentArtifacts.first {
            $0.direction == .incoming
                && $0.kind == .ecash
                && ($0.cashuToken == token
                    || ($0.valueKind != .cashuPaymentRequest && $0.value == token))
                && ($0.state == nil || $0.state == .completed)
        }
    }

    private func upsertPaymentArtifact(_ artifact: CashuPaymentArtifactRecord) throws {
        paymentArtifacts.removeAll { existing in
            existing.id == artifact.id
                || (artifact.valueKind != .cashuPaymentRequest
                    && !artifact.value.isEmpty
                    && existing.kind == artifact.kind
                    && existing.value == artifact.value)
                || (artifact.transactionID != nil
                    && existing.transactionID == artifact.transactionID)
                || (artifact.operationID != nil
                    && existing.operationID == artifact.operationID)
                || (artifact.quoteID != nil
                    && existing.quoteID == artifact.quoteID
                    && existing.direction == artifact.direction)
        }
        paymentArtifacts.append(artifact)
        paymentArtifacts.sort { $0.createdAt > $1.createdAt }
        try persistPaymentArtifacts()
    }

    private func removePaymentArtifact(
        quoteID: String,
        direction: CashuTransactionDirection
    ) throws {
        paymentArtifacts.removeAll {
            $0.quoteID == quoteID && $0.direction == direction
        }
        try persistPaymentArtifacts()
    }

    private func removePaymentArtifact(id: String) throws {
        paymentArtifacts.removeAll { $0.id == id }
        try persistPaymentArtifacts()
    }

    private func updateLightningPaymentArtifact(
        quoteID: String,
        state: CashuTransactionState,
        transactionID: String? = nil,
        lastCheckedAt: Date,
        feePaid: UInt64? = nil,
        paymentProof: String? = nil
    ) throws {
        guard let index = paymentArtifacts.firstIndex(where: {
            $0.quoteID == quoteID
                && $0.direction == .outgoing
                && $0.kind == .lightning
        }) else { return }
        paymentArtifacts[index].state = state
        paymentArtifacts[index].lastCheckedAt = lastCheckedAt
        if let transactionID {
            paymentArtifacts[index] = CashuPaymentArtifactRecord(
                id: paymentArtifacts[index].id,
                transactionID: transactionID,
                operationID: paymentArtifacts[index].operationID,
                quoteID: paymentArtifacts[index].quoteID,
                mintURL: paymentArtifacts[index].mintURL,
                direction: paymentArtifacts[index].direction,
                kind: paymentArtifacts[index].kind,
                value: paymentArtifacts[index].value,
                valueKind: paymentArtifacts[index].valueKind,
                cashuToken: paymentArtifacts[index].cashuToken,
                amount: paymentArtifacts[index].amount,
                memo: paymentArtifacts[index].memo,
                createdAt: paymentArtifacts[index].createdAt,
                state: state,
                lastCheckedAt: lastCheckedAt,
                feePaid: feePaid ?? paymentArtifacts[index].feePaid,
                paymentProof: paymentProof ?? paymentArtifacts[index].paymentProof,
                expiresAt: paymentArtifacts[index].expiresAt
            )
        } else {
            if let feePaid { paymentArtifacts[index].feePaid = feePaid }
            if let paymentProof { paymentArtifacts[index].paymentProof = paymentProof }
        }
        try persistPaymentArtifacts()
    }

    private func recordLightningPaymentResult(
        _ result: CashuLightningPaymentResult,
        wallet: Wallet
    ) async {
        let transaction = await newTransaction(
            wallet: wallet,
            direction: .outgoing,
            quoteID: result.quoteID,
            expectedAmount: result.amount
        )
        try? updateLightningPaymentArtifact(
            quoteID: result.quoteID,
            state: result.state == .completed ? .completed : .pending,
            transactionID: transaction?.id.hex,
            lastCheckedAt: Date(),
            feePaid: result.feePaid,
            paymentProof: result.preimage
        )
    }

    private func persistPaymentArtifacts() throws {
        let directory = paymentArtifactsURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(paymentArtifacts)
#if os(iOS)
        try data.write(
            to: paymentArtifactsURL,
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
#else
        try data.write(to: paymentArtifactsURL, options: .atomic)
#endif
    }

    static func loadPaymentArtifacts(from url: URL) -> [CashuPaymentArtifactRecord] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([CashuPaymentArtifactRecord].self, from: data)) ?? []
    }

    private func upsertLightningReceiveQuote(_ quote: CashuLightningReceiveQuote) throws {
        lightningReceiveQuotes.removeAll { $0.id == quote.id }
        lightningReceiveQuotes.append(quote)
        lightningReceiveQuotes.sort { $0.createdAt > $1.createdAt }
        try persistLightningReceiveQuotes()
    }

    private func discardUnpaidLightningReceiveQuote(id: String) throws {
        guard let quote = lightningReceiveQuotes.first(where: { $0.id == id }),
              quote.state == .unpaid else { return }
        lightningReceiveQuotes.removeAll { $0.id == id }
        paymentArtifacts.removeAll {
            $0.quoteID == id && $0.direction == .incoming && $0.kind == .lightning
        }
        try persistLightningReceiveQuotes()
        try persistPaymentArtifacts()
    }

    private func persistLightningReceiveQuotes() throws {
        let directory = lightningReceiveQuotesURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(lightningReceiveQuotes)
#if os(iOS)
        try data.write(
            to: lightningReceiveQuotesURL,
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
#else
        try data.write(to: lightningReceiveQuotesURL, options: .atomic)
#endif
    }

    private static func loadLightningReceiveQuotes(from url: URL) -> [CashuLightningReceiveQuote] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([CashuLightningReceiveQuote].self, from: data)) ?? []
    }

    private func lightningReceiveQuote(
        from quote: MintQuote,
        fallbackAmount: UInt64,
        createdAt: Date
    ) -> CashuLightningReceiveQuote {
        let expiresAt = quote.expiry > 0
            ? Date(timeIntervalSince1970: TimeInterval(quote.expiry))
            : nil
        var state = Self.lightningReceiveState(from: quote.state)
        if state == .unpaid, let expiresAt, expiresAt <= Date() { state = .expired }
        return CashuLightningReceiveQuote(
            id: quote.id,
            mintURL: quote.mintUrl.url,
            amount: quote.amount?.value ?? fallbackAmount,
            invoice: quote.request,
            createdAt: createdAt,
            expiresAt: expiresAt,
            state: state,
            issuedAmount: quote.amountIssued.value
        )
    }

    private static func lightningReceiveState(from state: QuoteState) -> CashuLightningReceiveState {
        switch state {
        case .unpaid: .unpaid
        case .paid: .paid
        case .pending: .pending
        case .issued: .issued
        }
    }

    private static func displayName(for mintURL: String) -> String {
        URL(string: mintURL)?.host() ?? mintURL
    }

    private static let paymentRequestReceiveOperationPrefix = "payment-request-receive:"

    private static func paymentRequestReceiveOperationID(for eventID: String) -> String {
        paymentRequestReceiveOperationPrefix + eventID.lowercased()
    }

    private static func paymentRequestReceiveEventID(from operationID: String?) -> String? {
        guard let operationID,
              operationID.hasPrefix(paymentRequestReceiveOperationPrefix) else { return nil }
        let eventID = String(operationID.dropFirst(paymentRequestReceiveOperationPrefix.count))
        return eventID.isEmpty ? nil : eventID
    }

    private func incomingPaymentRequestTransaction(
        wallet: Wallet,
        eventID: String
    ) async -> Transaction? {
        guard let transactions = try? await wallet.listTransactions(direction: .incoming) else {
            return nil
        }
        return transactions.first {
            $0.metadata["source"] == "taskify-native-payment-request"
                && $0.metadata["nostr_event_id"]?.lowercased() == eventID.lowercased()
        }
    }

    private func backfillOutgoingPaymentRequestTokens(
        wallet: Wallet,
        transactions: [Transaction]
    ) async throws {
        var changed = false
        for index in paymentArtifacts.indices where
            paymentArtifacts[index].direction == .outgoing
                && paymentArtifacts[index].kind == .ecash
                && paymentArtifacts[index].valueKind == .cashuPaymentRequest
                && paymentArtifacts[index].cashuToken == nil {
            let artifact = paymentArtifacts[index]
            guard let transaction = transactions.first(where: {
                (artifact.transactionID != nil && $0.id.hex == artifact.transactionID)
                    || (artifact.operationID != nil && $0.sagaId == artifact.operationID)
            }),
            let token = await cashuToken(for: transaction, wallet: wallet) else {
                continue
            }
            paymentArtifacts[index].cashuToken = token
            changed = true
        }
        if changed { try persistPaymentArtifacts() }
    }

    private func cashuToken(
        for transaction: Transaction?,
        wallet: Wallet
    ) async -> String? {
        guard let transaction,
              let proofs = try? await wallet.getProofsForTransaction(id: transaction.id),
              !proofs.isEmpty else { return nil }
        return try? CashuPaymentRequestContract.tokenString(
            mintURL: transaction.mintUrl.url,
            unit: "sat",
            memo: transaction.memo,
            proofs: proofs
        )
    }

    private func finalizeNostrPayment(
        delivery: CashuNostrPaymentDelivery,
        request: CashuCreatedPaymentRequest,
        mintURL: String,
        amount: UInt64,
        memo: String?,
        cashuToken: String,
        transaction: Transaction?
    ) throws -> CashuPaymentRequestReceipt {
        let operationID = Self.paymentRequestReceiveOperationID(for: delivery.eventID)
        try upsertPaymentArtifact(
            CashuPaymentArtifactRecord(
                id: operationID,
                transactionID: transaction?.id.hex,
                operationID: operationID,
                mintURL: mintURL,
                direction: .incoming,
                kind: .ecash,
                value: request.encoded,
                valueKind: .cashuPaymentRequest,
                cashuToken: cashuToken,
                amount: amount,
                memo: memo,
                createdAt: delivery.receivedAt,
                state: .completed,
                lastCheckedAt: Date(),
                feePaid: transaction?.fee.value
            )
        )
        try reconcileCreatedPaymentRequestsFromArtifacts()
        if let index = createdPaymentRequests.firstIndex(where: {
            $0.requestID == request.requestID
        }) {
            createdPaymentRequests[index].lastSenderPublicKey = delivery.senderPublicKey
            try persistCreatedPaymentRequests()
        }
        return CashuPaymentRequestReceipt(
            eventID: delivery.eventID,
            requestID: request.requestID,
            mintURL: mintURL,
            amount: amount,
            memo: memo,
            senderPublicKey: delivery.senderPublicKey
        )
    }

    private func reconcileCreatedPaymentRequestsFromArtifacts() throws {
        var changed = false
        for index in createdPaymentRequests.indices {
            let request = createdPaymentRequests[index]
            let receipts = paymentArtifacts.filter {
                $0.direction == .incoming
                    && $0.kind == .ecash
                    && $0.valueKind == .cashuPaymentRequest
                    && $0.value == request.encoded
                    && $0.state == .completed
                    && ($0.amount ?? 0) > 0
            }
            guard !receipts.isEmpty else { continue }
            var total = UInt64(0)
            for receipt in receipts {
                let addition = total.addingReportingOverflow(receipt.amount ?? 0)
                total = addition.overflow ? UInt64.max : addition.partialValue
            }
            let eventIDs = receipts.compactMap {
                Self.paymentRequestReceiveEventID(from: $0.operationID)
            }
            var updated = request
            updated.receivedAmount = total
            updated.receivedCount = receipts.count
            updated.lastReceivedAt = receipts.map(\.createdAt).max()
            updated.processedEventIDs = Array(eventIDs.suffix(100))
            if request.singleUse, !receipts.isEmpty {
                updated.state = .completed
            }
            if updated != request {
                createdPaymentRequests[index] = updated
                changed = true
            }
        }
        if changed { try persistCreatedPaymentRequests() }
    }

    private func transactionIDs(
        wallet: Wallet,
        direction: TransactionDirection
    ) async throws -> Set<String> {
        Set(try await wallet.listTransactions(direction: direction).map { $0.id.hex })
    }

    private func newTransaction(
        wallet: Wallet,
        direction: TransactionDirection,
        knownIDs: Set<String>? = nil,
        operationID: String? = nil,
        quoteID: String? = nil,
        expectedAmount: UInt64? = nil
    ) async -> Transaction? {
        guard let transactions = try? await wallet.listTransactions(direction: direction) else {
            return nil
        }
        if let operationID,
           let transaction = transactions.first(where: { $0.sagaId == operationID }) {
            return transaction
        }
        if let quoteID,
           let transaction = transactions.first(where: { $0.quoteId == quoteID }) {
            return transaction
        }
        guard let knownIDs else { return nil }
        let newTransactions = transactions
            .filter { !knownIDs.contains($0.id.hex) }
            .filter { expectedAmount == nil || $0.amount.value == expectedAmount }
            .sorted { $0.timestamp > $1.timestamp }
        return newTransactions.first
    }

    static func matchingPaymentArtifact(
        in artifacts: [CashuPaymentArtifactRecord],
        transactionID: String,
        operationID: String?,
        quoteID: String?,
        mintURL: String,
        direction: CashuTransactionDirection,
        kind: CashuTransactionKind,
        amount: UInt64,
        date: Date
    ) -> CashuPaymentArtifactRecord? {
        let compatible = artifacts.filter {
            $0.mintURL == mintURL && $0.direction == direction && $0.kind == kind
        }
        if let exact = compatible.first(where: { $0.transactionID == transactionID }) {
            return exact
        }
        if let operationID,
           let exact = compatible.first(where: { $0.operationID == operationID }) {
            return exact
        }
        if let quoteID,
           let exact = compatible.first(where: { $0.quoteID == quoteID }) {
            return exact
        }

        // This only supports artifacts written immediately around a transaction
        // when an older CDK build did not expose its transaction identifier. A
        // unique match is required so a token is never attached to the wrong row.
        let nearby = compatible.filter {
            ($0.amount == nil || $0.amount == amount)
                && abs($0.createdAt.timeIntervalSince(date)) <= 120
        }
        return nearby.count == 1 ? nearby[0] : nil
    }

    static func isCounterDesynchronizationMessage(_ message: String) -> Bool {
        let normalized = message.lowercased()
        return normalized.contains("duplicate outputs")
            || normalized.contains("already signed")
            || normalized.contains("outputs already signed")
    }

    static func isTokenAlreadySpentMessage(_ message: String) -> Bool {
        let normalized = message.lowercased()
        return normalized.contains("token already spent")
            || normalized.contains("proof already spent")
            || normalized.contains("proofs already spent")
            || normalized.contains("inputs have already been spent")
            || normalized.contains("duplicate inputs")
    }

    private static func findSeedBackup(in value: Any) -> [String: Any]? {
        if let dictionary = value as? [String: Any] {
            if dictionary["type"] as? String == "nut13-wallet-backup" {
                return dictionary
            }
            for nested in dictionary.values {
                if let found = findSeedBackup(in: nested) { return found }
            }
        } else if let array = value as? [Any] {
            for nested in array {
                if let found = findSeedBackup(in: nested) { return found }
            }
        }
        return nil
    }

    private func transactionSummary(_ transaction: Transaction) -> CashuTransactionSummary {
        let kind: CashuTransactionKind
        switch transaction.paymentMethod {
        case .bolt11?: kind = .lightning
        default: kind = .ecash
        }
        let direction: CashuTransactionDirection = transaction.direction == .incoming
            ? .incoming
            : .outgoing
        let date = Date(timeIntervalSince1970: TimeInterval(transaction.timestamp))
        let artifact = Self.matchingPaymentArtifact(
            in: paymentArtifacts,
            transactionID: transaction.id.hex,
            operationID: transaction.sagaId,
            quoteID: transaction.quoteId,
            mintURL: transaction.mintUrl.url,
            direction: direction,
            kind: kind,
            amount: transaction.amount.value,
            date: date
        )
        let journaledInvoice = transaction.quoteId.flatMap { quoteID in
            lightningReceiveQuotes.first(where: { $0.id == quoteID })?.invoice
        }
        let outgoingToken = (transaction.sagaId ?? artifact?.operationID).flatMap { operationID in
            outgoingTokens.first(where: { $0.operationID == operationID })
        }
        return CashuTransactionSummary(
            id: transaction.id.hex,
            mintURL: transaction.mintUrl.url,
            direction: direction,
            amount: transaction.amount.value,
            fee: transaction.fee.value,
            date: date,
            memo: transaction.memo ?? artifact?.memo,
            kind: kind,
            quoteID: transaction.quoteId,
            paymentRequest: kind == .lightning
                ? (transaction.paymentRequest ?? artifact?.value ?? journaledInvoice)
                : nil,
            paymentProof: transaction.paymentProof ?? artifact?.paymentProof,
            cashuToken: kind == .ecash
                ? (artifact?.cashuToken
                    ?? (artifact?.valueKind != .cashuPaymentRequest ? artifact?.value : nil)
                    ?? outgoingToken?.token)
                : nil,
            cashuPaymentRequest: kind == .ecash
                ? (transaction.paymentRequest
                    ?? (artifact?.valueKind == .cashuPaymentRequest ? artifact?.value : nil))
                : nil,
            state: artifact?.state ?? .completed,
            outgoingTokenStatus: kind == .ecash ? outgoingToken?.status : nil,
            outgoingTokenID: outgoingToken?.id,
            tokenLastCheckedAt: outgoingToken?.lastCheckedAt,
            tokenSpentProofCount: outgoingToken?.spentProofCount,
            tokenProofCount: outgoingToken?.proofCount
        )
    }
}
