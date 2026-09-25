import CryptoKit
import Foundation

// Moves ecash to a Nostr Wallet Connect wallet by paying invoices the NWC wallet creates.
// Port of the PWA's nwcSweep.ts. Funds-safety rules:
// - A payment is only confirmed when amount + fee reserve + wallet (input) fee fits the budget.
// - The mint's quoted amount must equal the invoice amount the NWC wallet was asked for.
// - The journal is saved before every confirm; CDK keeps its own saga records for the proofs.
// - A payment whose outcome is unknown or pending is never retried: the source waits.
// - Payment is verified by preimage (sha256(preimage) == payment hash) or lookup_invoice.

public struct SweepPlan: Equatable, Sendable {
    /// Sats the source can spend right now.
    public let spendableSat: UInt64
    /// Sats held in proofs that are pending or reserved elsewhere; never swept.
    public let excludedSat: UInt64

    public init(spendableSat: UInt64, excludedSat: UInt64) {
        self.spendableSat = spendableSat
        self.excludedSat = excludedSat
    }
}

/// The source's answer to "pay this invoice": prepared (inputs reserved) or too expensive.
public struct SweepPreparation: Equatable, Sendable {
    public let handle: UUID?
    public let quoteID: String
    public let amountSat: UInt64
    public let feeReserveSat: UInt64
    /// Input/swap fee of the selected proofs; nil when not prepared.
    public let walletFeeSat: UInt64?

    public var isPrepared: Bool { handle != nil }
    public var requiredSat: UInt64 { amountSat &+ feeReserveSat &+ (walletFeeSat ?? 0) }

    public init(handle: UUID?, quoteID: String, amountSat: UInt64, feeReserveSat: UInt64, walletFeeSat: UInt64?) {
        self.handle = handle
        self.quoteID = quoteID
        self.amountSat = amountSat
        self.feeReserveSat = feeReserveSat
        self.walletFeeSat = walletFeeSat
    }
}

public enum SweepMeltState: String, Codable, Sendable {
    case paid
    case pending
    case unpaid
}

public struct SweepMeltResult: Equatable, Sendable {
    public let state: SweepMeltState
    public let preimage: String?
    /// Total fee the payment cost (lightning fee plus input fees), when the source knows it.
    public let feePaidSat: UInt64?

    public init(state: SweepMeltState, preimage: String?, feePaidSat: UInt64?) {
        self.state = state
        self.preimage = preimage
        self.feePaidSat = feePaidSat
    }
}

public protocol SweepSource: Sendable {
    var id: String { get }
    var label: String { get }
    func plan() async throws -> SweepPlan
    /// Quotes the invoice; prepares (reserves inputs) only if the total fits `budgetSat`.
    func prepare(invoice: String, budgetSat: UInt64) async throws -> SweepPreparation
    func cancel(_ preparation: SweepPreparation) async
    func confirm(_ preparation: SweepPreparation) async throws -> SweepMeltResult
    /// Nil when the mint can't be reached.
    func check(quoteID: String) async -> SweepMeltResult?
}

public protocol SweepDestination: Sendable {
    func makeInvoice(amountSat: UInt64, memo: String) async throws -> NWCInvoice
    func lookupInvoice(paymentHash: String?, invoice: String) async -> NWCInvoiceStatus?
}

public enum SweepAttemptState: String, Codable, Sendable {
    case invoice, quoted, melting, pending, paid, unpaid, error
}

public enum SweepVerification: String, Codable, Sendable {
    case preimage, lookup, unverified, mismatch
}

public struct SweepAttempt: Codable, Equatable, Sendable {
    public var attemptID: String
    public var invoice: String
    public var paymentHash: String?
    public var amountSat: UInt64
    public var quoteID: String?
    public var feeReserveSat: UInt64?
    public var walletFeeSat: UInt64?
    public var state: SweepAttemptState
    public var note: String?
    public var preimage: String?
    public var feePaidSat: UInt64?
    public var verification: SweepVerification?
    public var error: String?
    public var createdAt: Date
    public var updatedAt: Date
}

public enum SweepSourceStatus: String, Codable, Sendable {
    case pending, inProgress, swept, dust, awaitingSettlement, failed

    public var isFinal: Bool { self == .swept || self == .dust }
}

public struct SweepSourceRecord: Codable, Equatable, Sendable {
    public var sourceID: String
    public var label: String
    public var status: SweepSourceStatus
    public var startSpendableSat: UInt64?
    public var remainingSat: UInt64?
    public var excludedSat: UInt64?
    public var sentSat: UInt64
    public var feesSat: UInt64
    public var attempts: [SweepAttempt]
    public var error: String?
}

public enum SweepRunStatus: String, Codable, Sendable {
    case running, completed, incomplete
}

public struct SweepJournal: Codable, Equatable, Sendable {
    public var version: Int
    public var runID: String
    public var createdAt: Date
    public var updatedAt: Date
    public var status: SweepRunStatus
    public var sources: [SweepSourceRecord]

    public init(sources: [(id: String, label: String)], now: Date = Date()) {
        version = 1
        runID = UUID().uuidString
        createdAt = now
        updatedAt = now
        status = .running
        self.sources = sources.map {
            SweepSourceRecord(sourceID: $0.id, label: $0.label, status: .pending, sentSat: 0, feesSat: 0, attempts: [])
        }
    }

    public var hasUnsettledMelts: Bool {
        sources.contains { $0.attempts.contains { $0.state == .melting || $0.state == .pending } }
    }

    public var summary: SweepSummary {
        SweepSummary(
            sentSat: sources.reduce(0) { $0 + $1.sentSat },
            feesSat: sources.reduce(0) { $0 + $1.feesSat },
            remainingSat: sources.reduce(0) { $0 + ($1.remainingSat ?? 0) },
            unconfirmedSat: sources.flatMap(\.attempts)
                .filter { $0.state == .paid && ($0.verification == .mismatch || $0.verification == .unverified) }
                .reduce(0) { $0 + $1.amountSat },
            complete: sources.allSatisfy { $0.status.isFinal }
        )
    }
}

public struct SweepSummary: Equatable, Sendable {
    public let sentSat: UInt64
    public let feesSat: UInt64
    public let remainingSat: UInt64
    public let unconfirmedSat: UInt64
    public let complete: Bool
}

public protocol SweepJournalStore: Sendable {
    func load() -> SweepJournal?
    func save(_ journal: SweepJournal) throws
}

/// Journal file written atomically before every step.
public struct FileSweepJournalStore: SweepJournalStore {
    public let url: URL

    public init(url: URL) {
        self.url = url
    }

    public func load() -> SweepJournal? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(SweepJournal.self, from: data)
    }

    public func save(_ journal: SweepJournal) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(journal)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    public func clear() {
        try? FileManager.default.removeItem(at: url)
    }
}

public struct SweepSafetyError: LocalizedError, Equatable {
    public let message: String
    public var errorDescription: String? { message }
}

public struct SweepOptions: Sendable {
    public var minSweepSat: UInt64 = 1
    public var maxFeeReserveRatio: Double = 0.05
    public var feeReserveFloorSat: UInt64 = 10
    public var maxQuoteAttempts = 6
    public var maxPasses = 3
    public var lookupAttempts = 5
    public var lookupDelay: Duration = .seconds(2)
    public var memo = "Taskify wallet migration"
    public var onUpdate: (@Sendable (SweepJournal) -> Void)?

    public init() {}
}

public func preimageMatchesPaymentHash(_ preimage: String, _ paymentHash: String) -> Bool {
    let preimage = preimage.lowercased()
    let paymentHash = paymentHash.lowercased()
    guard preimage.count == 64, paymentHash.count == 64, let data = try? Data(hex: preimage) else { return false }
    return Data(SHA256.hash(data: data)).hexString == paymentHash
}

/// Sweeps each source to the destination, one at a time. Pass an existing journal to resume.
public func runSweep(
    sources: [any SweepSource],
    destination: any SweepDestination,
    store: any SweepJournalStore,
    journal existing: SweepJournal? = nil,
    options: SweepOptions = SweepOptions()
) async -> SweepJournal {
    let runner = SweepRunner(
        journal: existing ?? SweepJournal(sources: sources.map { ($0.id, $0.label) }),
        store: store,
        destination: destination,
        options: options
    )
    return await runner.run(sources)
}

private actor SweepRunner {
    private var journal: SweepJournal
    private let store: any SweepJournalStore
    private let destination: any SweepDestination
    private let options: SweepOptions

    init(journal: SweepJournal, store: any SweepJournalStore, destination: any SweepDestination, options: SweepOptions) {
        self.journal = journal
        self.store = store
        self.destination = destination
        self.options = options
    }

    private enum PassOutcome { case paid, dust, unsettled }

    private func persist() throws {
        journal.updatedAt = Date()
        try store.save(journal)
        options.onUpdate?(journal)
    }

    private func index(of sourceID: String, label: String) -> Int {
        if let index = journal.sources.firstIndex(where: { $0.sourceID == sourceID }) { return index }
        journal.sources.append(SweepSourceRecord(sourceID: sourceID, label: label, status: .pending, sentSat: 0, feesSat: 0, attempts: []))
        return journal.sources.count - 1
    }

    private func updateAttempt(_ source: Int, _ attempt: Int, _ change: (inout SweepAttempt) -> Void) throws {
        change(&journal.sources[source].attempts[attempt])
        journal.sources[source].attempts[attempt].updatedAt = Date()
        try persist()
    }

    func run(_ sources: [any SweepSource]) async -> SweepJournal {
        journal.status = .running
        try? persist()
        for source in sources {
            let i = index(of: source.id, label: source.label)
            journal.sources[i].label = source.label
            if journal.sources[i].status.isFinal { continue }
            do {
                try await sweep(source, record: i)
            } catch {
                journal.sources[i].status = .failed
                journal.sources[i].error = error.localizedDescription
                try? persist()
            }
        }
        journal.status = journal.sources.allSatisfy { $0.status.isFinal } ? .completed : .incomplete
        try? persist()
        return journal
    }

    private func sweep(_ source: any SweepSource, record i: Int) async throws {
        journal.sources[i].status = .inProgress
        journal.sources[i].error = nil
        try persist()

        guard try await settleOutstanding(source, record: i) else {
            journal.sources[i].status = .awaitingSettlement
            try persist()
            return
        }

        for _ in 0..<options.maxPasses {
            let plan = try await source.plan()
            if journal.sources[i].startSpendableSat == nil { journal.sources[i].startSpendableSat = plan.spendableSat }
            journal.sources[i].remainingSat = plan.spendableSat
            journal.sources[i].excludedSat = plan.excludedSat
            try persist()

            switch try await meltOnce(source, record: i, budget: plan.spendableSat) {
            case .dust:
                journal.sources[i].status = journal.sources[i].sentSat > 0 ? .swept : .dust
                try persist()
                return
            case .unsettled:
                journal.sources[i].status = .awaitingSettlement
                try persist()
                return
            case .paid:
                continue
            }
        }
        let final = try await source.plan()
        journal.sources[i].remainingSat = final.spendableSat
        journal.sources[i].excludedSat = final.excludedSat
        journal.sources[i].status = .swept
        try persist()
    }

    private func settleOutstanding(_ source: any SweepSource, record i: Int) async throws -> Bool {
        var settled = true
        for a in journal.sources[i].attempts.indices {
            let state = journal.sources[i].attempts[a].state
            guard state == .melting || state == .pending else { continue }
            guard let quoteID = journal.sources[i].attempts[a].quoteID else {
                try updateAttempt(i, a) { $0.state = .error; $0.error = "Payment started without a quote id" }
                continue
            }
            guard let status = await source.check(quoteID: quoteID) else {
                settled = false
                continue
            }
            switch status.state {
            case .pending:
                if state != .pending { try updateAttempt(i, a) { $0.state = .pending } }
                settled = false
            case .unpaid:
                try updateAttempt(i, a) { $0.state = .unpaid; $0.note = "The mint reported the payment unpaid" }
            case .paid:
                try await completePaid(record: i, attempt: a, result: status)
            }
        }
        return settled
    }

    private func completePaid(record i: Int, attempt a: Int, result: SweepMeltResult) async throws {
        let attempt = journal.sources[i].attempts[a]
        // Without an exact figure, count the most it could have cost.
        let fee = result.feePaidSat ?? ((attempt.feeReserveSat ?? 0) &+ (attempt.walletFeeSat ?? 0))
        try updateAttempt(i, a) {
            $0.state = .paid
            $0.preimage = result.preimage ?? $0.preimage
            $0.feePaidSat = result.feePaidSat
        }
        journal.sources[i].sentSat &+= attempt.amountSat
        journal.sources[i].feesSat &+= fee
        try persist()
        await verify(record: i, attempt: a)
    }

    private func verify(record i: Int, attempt a: Int) async {
        let attempt = journal.sources[i].attempts[a]
        if let preimage = attempt.preimage, let hash = attempt.paymentHash {
            let matches = preimageMatchesPaymentHash(preimage, hash)
            try? updateAttempt(i, a) { $0.verification = matches ? .preimage : .mismatch }
            if matches { return }
        }
        for n in 0..<options.lookupAttempts {
            if let status = await destination.lookupInvoice(paymentHash: attempt.paymentHash, invoice: attempt.invoice) {
                if status.settled {
                    // The receiving wallet's confirmation outranks a preimage that didn't match.
                    try? updateAttempt(i, a) { $0.verification = .lookup }
                    return
                }
            } else {
                break // wallet can't look invoices up
            }
            if n < options.lookupAttempts - 1 { try? await Task.sleep(for: options.lookupDelay) }
        }
        if journal.sources[i].attempts[a].verification == nil {
            try? updateAttempt(i, a) { $0.verification = .unverified }
        }
    }

    private func feeReserveAllowed(amount: UInt64, feeReserve: UInt64) -> Bool {
        let ratio = UInt64((Double(amount) * options.maxFeeReserveRatio).rounded(.up))
        return feeReserve <= max(options.feeReserveFloorSat, ratio)
    }

    private func meltOnce(_ source: any SweepSource, record i: Int, budget: UInt64) async throws -> PassOutcome {
        guard budget >= options.minSweepSat else { return .dust }
        var tried = Set<UInt64>()
        let guess = max(2, (budget + 99) / 100) + 1
        var target = budget > guess ? budget - guess : 0
        var chosen: (preparation: SweepPreparation, attempt: Int)?
        // Input fees the source didn't report (e.g. a swap before paying) are unknown;
        // widen the margin each time the source can't cover the total.
        var unknownFeeMargin: UInt64 = 2

        for _ in 0..<options.maxQuoteAttempts {
            guard target >= options.minSweepSat, !tried.contains(target) else { break }
            tried.insert(target)

            let invoice = try await destination.makeInvoice(amountSat: target, memo: options.memo)
            let now = Date()
            journal.sources[i].attempts.append(SweepAttempt(
                attemptID: UUID().uuidString,
                invoice: invoice.invoice,
                paymentHash: invoice.paymentHash,
                amountSat: target,
                state: .invoice,
                createdAt: now,
                updatedAt: now
            ))
            let a = journal.sources[i].attempts.count - 1
            try persist()

            let preparation: SweepPreparation
            do {
                preparation = try await source.prepare(invoice: invoice.invoice, budgetSat: budget)
            } catch {
                try updateAttempt(i, a) { $0.state = .error; $0.error = error.localizedDescription }
                throw error
            }
            try updateAttempt(i, a) {
                $0.state = .quoted
                $0.quoteID = preparation.quoteID
                $0.feeReserveSat = preparation.feeReserveSat
                $0.walletFeeSat = preparation.walletFeeSat
            }
            guard preparation.amountSat == target else {
                await source.cancel(preparation)
                try updateAttempt(i, a) { $0.state = .error; $0.error = "Mint quoted \(preparation.amountSat) sats for a \(target) sat invoice" }
                throw SweepSafetyError(message: "The mint's quote (\(preparation.amountSat) sats) doesn't match the wallet's invoice (\(target) sats); stopped.")
            }
            if preparation.isPrepared, preparation.requiredSat <= budget {
                chosen = (preparation, a)
                break
            }
            if preparation.isPrepared { await source.cancel(preparation) }
            try updateAttempt(i, a) { $0.note = "Needs more than the \(budget) sats available" }
            let walletFee: UInt64
            if let known = preparation.walletFeeSat {
                walletFee = known
            } else {
                walletFee = unknownFeeMargin
                unknownFeeMargin = unknownFeeMargin &* 2
            }
            let fees = preparation.feeReserveSat &+ walletFee
            let next = budget > fees ? budget - fees : 0
            target = min(next, target > 0 ? target - 1 : 0)
        }

        guard let (preparation, a) = chosen else {
            if journal.sources[i].sentSat > 0 || target < options.minSweepSat { return .dust }
            throw SweepSafetyError(message: "Couldn't find an amount that covers the mint's lightning fees.")
        }
        guard feeReserveAllowed(amount: preparation.amountSat, feeReserve: preparation.feeReserveSat) else {
            await source.cancel(preparation)
            throw SweepSafetyError(message: "The mint's lightning fee reserve (\(preparation.feeReserveSat) sats) is too high for \(preparation.amountSat) sats.")
        }

        do {
            try updateAttempt(i, a) { $0.state = .melting }
        } catch {
            // The journal couldn't be saved: don't pay without a record.
            await source.cancel(preparation)
            throw error
        }

        var result: SweepMeltResult
        do {
            result = try await source.confirm(preparation)
        } catch {
            guard let checked = await source.check(quoteID: preparation.quoteID) else {
                try updateAttempt(i, a) { $0.error = error.localizedDescription }
                return .unsettled
            }
            if checked.state == .unpaid {
                try updateAttempt(i, a) { $0.state = .unpaid; $0.error = error.localizedDescription }
                throw error
            }
            result = checked
        }

        switch result.state {
        case .pending:
            try updateAttempt(i, a) { $0.state = .pending }
            return .unsettled
        case .unpaid:
            try updateAttempt(i, a) { $0.state = .unpaid }
            throw SweepSafetyError(message: "The mint didn't pay the wallet's invoice.")
        case .paid:
            try await completePaid(record: i, attempt: a, result: result)
            return .paid
        }
    }
}
