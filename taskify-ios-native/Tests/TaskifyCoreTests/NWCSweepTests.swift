import CryptoKit
import Foundation
import XCTest
@testable import TaskifyCore

// MARK: - Fakes

private func randomHex(_ bytes: Int = 32) -> String {
    Data((0..<bytes).map { _ in UInt8.random(in: 0...255) }).hexString
}

private func powersOfTwo(_ amount: UInt64) -> [UInt64] {
    var out: [UInt64] = []
    var bit: UInt64 = 1
    var rest = amount
    while rest > 0 {
        if rest & 1 == 1 { out.append(bit) }
        rest >>= 1
        bit <<= 1
    }
    return out
}

/// Lightning network + NWC wallet: the mint "pays" invoices by calling settle().
private final class FakeLightning: SweepDestination, @unchecked Sendable {
    private let lock = NSLock()
    private var invoices: [String: (amount: UInt64, hash: String, preimage: String, settled: Bool)] = [:]
    private(set) var receivedSat: UInt64 = 0
    var amountSkew: Int64 = 0
    var omitHash = false
    var supportsLookup = true
    var failMakeInvoice = false

    func makeInvoice(amountSat: UInt64, memo: String) async throws -> NWCInvoice {
        try lock.withLock {
            if failMakeInvoice { throw NWCError.timedOut }
            let preimage = randomHex()
            let hash = Data(SHA256.hash(data: try Data(hex: preimage))).hexString
            let amount = UInt64(Int64(amountSat) + amountSkew)
            let invoice = "lnfake\(amount)n1\(randomHex(8))"
            invoices[invoice] = (amount, hash, preimage, false)
            return NWCInvoice(invoice: invoice, paymentHash: omitHash ? nil : hash)
        }
    }

    func lookupInvoice(paymentHash: String?, invoice: String) async -> NWCInvoiceStatus? {
        lock.withLock {
            guard supportsLookup, let entry = invoices[invoice] else { return nil }
            return NWCInvoiceStatus(settled: entry.settled, preimage: entry.settled ? entry.preimage : nil)
        }
    }

    func amount(of invoice: String) -> UInt64? {
        lock.withLock { invoices[invoice]?.amount }
    }

    func settle(_ invoice: String) -> String {
        lock.withLock {
            var entry = invoices[invoice]!
            precondition(!entry.settled, "invoice paid twice")
            entry.settled = true
            invoices[invoice] = entry
            receivedSat += entry.amount
            return entry.preimage
        }
    }
}

/// A CDK-like mint wallet: selects a subset of proofs, charges NUT-02 input fees on them,
/// reserves them while prepared, and returns change after paying.
private final class FakeMint: SweepSource, @unchecked Sendable {
    struct Quote {
        var invoice: String
        var amount: UInt64
        var feeReserve: UInt64
        var state: SweepMeltState
        var preimage: String?
        var feePaid: UInt64?
        var inputs: [UInt64] = []
        var walletFee: UInt64 = 0
    }

    let id: String
    let label: String
    private let lock = NSLock()
    private let lightning: FakeLightning
    private(set) var proofs: [UInt64]
    private var reserved: [UUID: (quoteID: String, inputs: [UInt64])] = [:]
    private var inFlight: [String: [UInt64]] = [:]
    private var quotes: [String: Quote] = [:]
    private(set) var lightningFees: UInt64 = 0
    private(set) var inputFees: UInt64 = 0
    private(set) var confirms = 0

    var inputFeePpk: UInt64
    var feeReserve: (UInt64) -> UInt64
    var actualFee: (UInt64, UInt64) -> UInt64

    var failBeforeSubmit = false
    var loseResponse = false
    var goesPending = false
    var failsUnpaid = false
    var checkUnavailable = false
    var quoteSkew: Int64 = 0

    init(
        _ lightning: FakeLightning,
        id: String,
        proofs: [UInt64],
        inputFeePpk: UInt64 = 0,
        feeReserve: @escaping (UInt64) -> UInt64 = { max(2, ($0 + 99) / 100) },
        actualFee: @escaping (UInt64, UInt64) -> UInt64 = { _, _ in 0 }
    ) {
        self.lightning = lightning
        self.id = id
        label = id
        self.proofs = proofs
        self.inputFeePpk = inputFeePpk
        self.feeReserve = feeReserve
        self.actualFee = actualFee
    }

    var unspentSat: UInt64 { lock.withLock { proofs.reduce(0, +) } }
    /// Everything the wallet still owns, including reserved and in-flight inputs.
    var ownedSat: UInt64 {
        lock.withLock {
            proofs.reduce(0, +)
                + reserved.values.flatMap(\.inputs).reduce(0, +)
                + inFlight.values.flatMap { $0 }.reduce(0, +)
        }
    }

    private func fee(for count: Int) -> UInt64 { (UInt64(count) * inputFeePpk + 999) / 1_000 }

    func plan() async throws -> SweepPlan {
        lock.withLock {
            SweepPlan(
                spendableSat: proofs.reduce(0, +),
                excludedSat: reserved.values.flatMap(\.inputs).reduce(0, +) + inFlight.values.flatMap { $0 }.reduce(0, +)
            )
        }
    }

    func prepare(invoice: String, budgetSat: UInt64) async throws -> SweepPreparation {
        guard let invoiceAmount = lightning.amount(of: invoice) else { throw NWCError.invalidResponse }
        return lock.withLock {
            let amount = UInt64(Int64(invoiceAmount) + quoteSkew)
            let reserve = feeReserve(amount)
            let quoteID = "q_\(randomHex(6))"
            quotes[quoteID] = Quote(invoice: invoice, amount: amount, feeReserve: reserve, state: .unpaid)
            if amount + reserve > budgetSat {
                return SweepPreparation(handle: nil, quoteID: quoteID, amountSat: amount, feeReserveSat: reserve, walletFeeSat: nil)
            }
            // Largest-first selection until inputs cover amount + reserve + their own fee.
            var selected: [UInt64] = []
            var remaining = proofs.sorted(by: >)
            while selected.reduce(0, +) < amount + reserve + fee(for: selected.count), !remaining.isEmpty {
                selected.append(remaining.removeFirst())
            }
            let walletFee = fee(for: selected.count)
            guard selected.reduce(0, +) >= amount + reserve + walletFee, amount + reserve + walletFee <= budgetSat else {
                return SweepPreparation(handle: nil, quoteID: quoteID, amountSat: amount, feeReserveSat: reserve, walletFeeSat: walletFee)
            }
            for value in selected { proofs.remove(at: proofs.firstIndex(of: value)!) }
            let handle = UUID()
            reserved[handle] = (quoteID, selected)
            quotes[quoteID]?.inputs = selected
            quotes[quoteID]?.walletFee = walletFee
            return SweepPreparation(handle: handle, quoteID: quoteID, amountSat: amount, feeReserveSat: reserve, walletFeeSat: walletFee)
        }
    }

    func cancel(_ preparation: SweepPreparation) async {
        lock.withLock {
            guard let handle = preparation.handle, let entry = reserved.removeValue(forKey: handle) else { return }
            proofs.append(contentsOf: entry.inputs)
        }
    }

    func confirm(_ preparation: SweepPreparation) async throws -> SweepMeltResult {
        try lock.withLock {
            confirms += 1
            guard let handle = preparation.handle, let entry = reserved.removeValue(forKey: handle) else {
                throw CashuWalletError.lightningPaymentMissing
            }
            if failBeforeSubmit {
                failBeforeSubmit = false
                proofs.append(contentsOf: entry.inputs)
                throw URLError(.notConnectedToInternet)
            }
            if failsUnpaid {
                failsUnpaid = false
                proofs.append(contentsOf: entry.inputs)
                throw NWCError.walletError(code: nil, message: "route not found")
            }
            inFlight[entry.quoteID] = entry.inputs
            if goesPending {
                quotes[entry.quoteID]?.state = .pending
                return SweepMeltResult(state: .pending, preimage: nil, feePaidSat: nil)
            }
            finishLocked(entry.quoteID)
            if loseResponse {
                loseResponse = false
                throw URLError(.networkConnectionLost)
            }
            let quote = quotes[entry.quoteID]!
            return SweepMeltResult(state: .paid, preimage: quote.preimage, feePaidSat: quote.feePaid)
        }
    }

    private func finishLocked(_ quoteID: String) {
        var quote = quotes[quoteID]!
        let inputs = inFlight.removeValue(forKey: quoteID) ?? []
        let lnFee = min(quote.feeReserve, actualFee(quote.amount, quote.feeReserve))
        quote.preimage = lightning.settle(quote.invoice)
        let change = inputs.reduce(0, +) - quote.amount - lnFee - quote.walletFee
        proofs.append(contentsOf: powersOfTwo(change))
        lightningFees += lnFee
        inputFees += quote.walletFee
        quote.state = .paid
        quote.feePaid = lnFee + quote.walletFee
        quotes[quoteID] = quote
    }

    func settlePending(paid: Bool) {
        lock.withLock {
            for (id, quote) in quotes where quote.state == .pending {
                if paid {
                    finishLocked(id)
                } else {
                    proofs.append(contentsOf: inFlight.removeValue(forKey: id) ?? [])
                    quotes[id]?.state = .unpaid
                }
            }
        }
    }

    func check(quoteID: String) async -> SweepMeltResult? {
        lock.withLock {
            guard !checkUnavailable, let quote = quotes[quoteID] else { return nil }
            return SweepMeltResult(state: quote.state, preimage: quote.preimage, feePaidSat: quote.feePaid)
        }
    }
}

private final class MemoryJournalStore: SweepJournalStore, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    var failSaves = false

    func load() -> SweepJournal? {
        lock.withLock {
            guard let data else { return nil }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            return try? decoder.decode(SweepJournal.self, from: data)
        }
    }

    func save(_ journal: SweepJournal) throws {
        try lock.withLock {
            if failSaves { throw CocoaError(.fileWriteOutOfSpace) }
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            data = try encoder.encode(journal)
        }
    }
}

private var fast: SweepOptions {
    var options = SweepOptions()
    options.lookupDelay = .zero
    return options
}

private func assertConserved(
    _ start: UInt64, _ mint: FakeMint, _ lightning: FakeLightning, _ journal: SweepJournal? = nil,
    file: StaticString = #filePath, line: UInt = #line
) {
    XCTAssertEqual(mint.ownedSat + lightning.receivedSat + mint.lightningFees + mint.inputFees, start, "sats created or destroyed", file: file, line: line)
    if let journal, let record = journal.sources.first(where: { $0.sourceID == mint.id }) {
        XCTAssertEqual(record.sentSat, lightning.receivedSat, file: file, line: line)
        XCTAssertEqual(record.feesSat, mint.lightningFees + mint.inputFees, file: file, line: line)
    }
}

// MARK: - Tests

final class NWCSweepTests: XCTestCase {
    func testPreimageVerification() throws {
        let preimage = randomHex()
        let hash = Data(SHA256.hash(data: try Data(hex: preimage))).hexString
        XCTAssertTrue(preimageMatchesPaymentHash(preimage, hash))
        XCTAssertTrue(preimageMatchesPaymentHash(preimage.uppercased(), hash))
        XCTAssertFalse(preimageMatchesPaymentHash(randomHex(), hash))
        XCTAssertFalse(preimageMatchesPaymentHash("nope", hash))
    }

    func testSweepsWholeBalanceLeavingOnlyReturnedReserve() async {
        let lightning = FakeLightning()
        let mint = FakeMint(lightning, id: "https://mint.a", proofs: powersOfTwo(10_000))
        let journal = await runSweep(sources: [mint], destination: lightning, store: MemoryJournalStore(), options: fast)
        XCTAssertEqual(journal.status, .completed)
        XCTAssertEqual(journal.sources[0].status, .swept)
        XCTAssertGreaterThanOrEqual(lightning.receivedSat, 9_990)
        XCTAssertTrue(journal.sources[0].attempts.filter { $0.state == .paid }.allSatisfy { $0.verification == .preimage })
        assertConserved(10_000, mint, lightning, journal)
    }

    func testInputFeesAndLargeReservesAreCovered() async {
        let lightning = FakeLightning()
        let mint = FakeMint(
            lightning, id: "https://mint.fees", proofs: Array(repeating: 64, count: 40), inputFeePpk: 1_000,
            feeReserve: { max(20, ($0 * 3 + 99) / 100) }, actualFee: { _, reserve in reserve }
        )
        let journal = await runSweep(sources: [mint], destination: lightning, store: MemoryJournalStore(), options: fast)
        XCTAssertNotEqual(journal.sources[0].status, .failed, journal.sources[0].error ?? "")
        XCTAssertGreaterThan(mint.inputFees, 0)
        assertConserved(40 * 64, mint, lightning, journal)
    }

    func testDustIsReportedWithoutInvoices() async {
        let lightning = FakeLightning()
        let mint = FakeMint(lightning, id: "https://mint.a", proofs: [1, 2], inputFeePpk: 1_000)
        let journal = await runSweep(sources: [mint], destination: lightning, store: MemoryJournalStore(), options: fast)
        XCTAssertEqual(journal.sources[0].status, .dust)
        XCTAssertEqual(journal.status, .completed)
        XCTAssertEqual(lightning.receivedSat, 0)
        XCTAssertEqual(mint.unspentSat, 3)
    }

    func testSeveralMintsAreIndependent() async {
        let lightning = FakeLightning()
        let bad = FakeMint(lightning, id: "https://mint.bad", proofs: powersOfTwo(1_000))
        bad.failsUnpaid = true
        let good = FakeMint(lightning, id: "https://mint.good", proofs: powersOfTwo(5_000), inputFeePpk: 100)
        let journal = await runSweep(sources: [bad, good], destination: lightning, store: MemoryJournalStore(), options: fast)
        XCTAssertEqual(journal.status, .incomplete)
        XCTAssertEqual(journal.sources[0].status, .failed)
        XCTAssertEqual(journal.sources[1].status, .swept)
        XCTAssertEqual(bad.unspentSat, 1_000)
    }

    func testPaymentThatNeverReachedTheMintKeepsEveryProofAndCanBeRetried() async {
        let lightning = FakeLightning()
        let mint = FakeMint(lightning, id: "https://mint.a", proofs: powersOfTwo(3_000))
        mint.failBeforeSubmit = true
        mint.checkUnavailable = false
        let store = MemoryJournalStore()
        // Mint knows the quote is unpaid, so the failure is final for this run.
        let first = await runSweep(sources: [mint], destination: lightning, store: store, options: fast)
        XCTAssertEqual(first.sources[0].status, .failed)
        XCTAssertEqual(mint.unspentSat, 3_000)
        let retried = await runSweep(sources: [mint], destination: lightning, store: store, journal: store.load(), options: fast)
        XCTAssertEqual(retried.status, .completed)
        assertConserved(3_000, mint, lightning, retried)
    }

    func testLostResponseIsRecoveredFromQuoteStateAndCountedOnce() async {
        let lightning = FakeLightning()
        let mint = FakeMint(lightning, id: "https://mint.a", proofs: powersOfTwo(7_777))
        mint.loseResponse = true
        let journal = await runSweep(sources: [mint], destination: lightning, store: MemoryJournalStore(), options: fast)
        XCTAssertEqual(journal.status, .completed)
        assertConserved(7_777, mint, lightning, journal)
    }

    func testUnknownOutcomeParksTheMintUntilItAnswers() async {
        let lightning = FakeLightning()
        let mint = FakeMint(lightning, id: "https://mint.a", proofs: powersOfTwo(4_096))
        mint.loseResponse = true
        mint.checkUnavailable = true
        let store = MemoryJournalStore()
        let first = await runSweep(sources: [mint], destination: lightning, store: store, options: fast)
        XCTAssertEqual(first.sources[0].status, .awaitingSettlement)
        XCTAssertTrue(first.hasUnsettledMelts)
        XCTAssertEqual(mint.confirms, 1)

        mint.checkUnavailable = false
        let resumed = await runSweep(sources: [mint], destination: lightning, store: store, journal: store.load(), options: fast)
        XCTAssertEqual(resumed.status, .completed)
        assertConserved(4_096, mint, lightning, resumed)
    }

    func testPendingPaymentIsNotRetriedAndSettlesOnResume() async {
        let lightning = FakeLightning()
        let mint = FakeMint(lightning, id: "https://mint.a", proofs: powersOfTwo(20_000))
        mint.goesPending = true
        let store = MemoryJournalStore()
        let first = await runSweep(sources: [mint], destination: lightning, store: store, options: fast)
        XCTAssertEqual(first.sources[0].status, .awaitingSettlement)
        let again = await runSweep(sources: [mint], destination: lightning, store: store, journal: store.load(), options: fast)
        XCTAssertEqual(again.sources[0].status, .awaitingSettlement)
        XCTAssertEqual(mint.confirms, 1)

        mint.goesPending = false
        mint.settlePending(paid: true)
        let done = await runSweep(sources: [mint], destination: lightning, store: store, journal: store.load(), options: fast)
        XCTAssertEqual(done.status, .completed)
        assertConserved(20_000, mint, lightning, done)
    }

    func testPendingPaymentThatFailsReturnsInputsAndIsReswept() async {
        let lightning = FakeLightning()
        let mint = FakeMint(lightning, id: "https://mint.a", proofs: powersOfTwo(2_500))
        mint.goesPending = true
        let store = MemoryJournalStore()
        _ = await runSweep(sources: [mint], destination: lightning, store: store, options: fast)
        mint.goesPending = false
        mint.settlePending(paid: false)
        let done = await runSweep(sources: [mint], destination: lightning, store: store, journal: store.load(), options: fast)
        XCTAssertEqual(done.status, .completed)
        XCTAssertTrue(done.sources[0].attempts.contains { $0.state == .unpaid })
        assertConserved(2_500, mint, lightning, done)
    }

    func testAmountMismatchesAbortBeforePaying() async {
        let lightning = FakeLightning()
        lightning.amountSkew = 1
        let mint = FakeMint(lightning, id: "https://mint.a", proofs: powersOfTwo(3_000))
        let journal = await runSweep(sources: [mint], destination: lightning, store: MemoryJournalStore(), options: fast)
        XCTAssertEqual(journal.sources[0].status, .failed)
        XCTAssertEqual(mint.confirms, 0)
        XCTAssertEqual(mint.unspentSat, 3_000, "a cancelled preparation must release its inputs")

        let lightning2 = FakeLightning()
        let mint2 = FakeMint(lightning2, id: "https://mint.b", proofs: powersOfTwo(3_000))
        mint2.quoteSkew = -5
        let journal2 = await runSweep(sources: [mint2], destination: lightning2, store: MemoryJournalStore(), options: fast)
        XCTAssertEqual(journal2.sources[0].status, .failed)
        XCTAssertEqual(mint2.unspentSat, 3_000)
    }

    func testExcessiveFeeReserveIsRefused() async {
        let lightning = FakeLightning()
        let mint = FakeMint(lightning, id: "https://mint.greedy", proofs: powersOfTwo(10_000), feeReserve: { $0 / 5 })
        let journal = await runSweep(sources: [mint], destination: lightning, store: MemoryJournalStore(), options: fast)
        XCTAssertEqual(journal.sources[0].status, .failed)
        XCTAssertEqual(mint.confirms, 0)
        XCTAssertEqual(mint.unspentSat, 10_000)
    }

    func testJournalSaveFailureStopsThePaymentAndReleasesInputs() async {
        let lightning = FakeLightning()
        let mint = FakeMint(lightning, id: "https://mint.a", proofs: powersOfTwo(5_000))
        let store = MemoryJournalStore()
        store.failSaves = true
        let journal = await runSweep(sources: [mint], destination: lightning, store: store, options: fast)
        XCTAssertNotEqual(journal.status, .completed)
        XCTAssertEqual(mint.confirms, 0)
        XCTAssertEqual(mint.unspentSat, 5_000)
    }

    func testVerificationFallsBackToLookupAndReportsUnconfirmed() async {
        let lightning = FakeLightning()
        lightning.omitHash = true
        let mint = FakeMint(lightning, id: "https://mint.a", proofs: powersOfTwo(2_000))
        let journal = await runSweep(sources: [mint], destination: lightning, store: MemoryJournalStore(), options: fast)
        XCTAssertTrue(journal.sources[0].attempts.filter { $0.state == .paid }.allSatisfy { $0.verification == .lookup })
        XCTAssertEqual(journal.summary.unconfirmedSat, 0)

        let lightning2 = FakeLightning()
        lightning2.omitHash = true
        lightning2.supportsLookup = false
        let mint2 = FakeMint(lightning2, id: "https://mint.b", proofs: powersOfTwo(2_000))
        let journal2 = await runSweep(sources: [mint2], destination: lightning2, store: MemoryJournalStore(), options: fast)
        XCTAssertEqual(journal2.summary.unconfirmedSat, journal2.sources[0].sentSat)
    }

    func testRandomizedConservation() async {
        var generator = SystemRandomNumberGenerator()
        for run in 0..<200 {
            let lightning = FakeLightning()
            let proofs = (0..<Int.random(in: 1...30, using: &generator)).map { _ in UInt64(1) << UInt64.random(in: 0...13, using: &generator) }
            let start = proofs.reduce(0, +)
            let pct = UInt64.random(in: 0...3, using: &generator)
            let floor = UInt64.random(in: 0...4, using: &generator)
            let mint = FakeMint(
                lightning, id: "https://mint.\(run)", proofs: proofs,
                inputFeePpk: Bool.random() ? UInt64.random(in: 0...999) : 0,
                feeReserve: { max(floor, ($0 * pct + 99) / 100) },
                actualFee: { _, reserve in UInt64.random(in: 0...reserve) }
            )
            switch Int.random(in: 0..<10) {
            case 0: mint.loseResponse = true
            case 1: mint.failsUnpaid = true
            case 2: mint.failBeforeSubmit = true
            case 3: mint.goesPending = true
            default: break
            }
            var options = fast
            options.maxFeeReserveRatio = 1
            let store = MemoryJournalStore()
            var journal = await runSweep(sources: [mint], destination: lightning, store: store, options: options)
            for _ in 0..<3 where journal.status != .completed {
                mint.goesPending = false
                mint.settlePending(paid: true)
                journal = await runSweep(sources: [mint], destination: lightning, store: store, journal: store.load(), options: options)
            }
            XCTAssertEqual(journal.status, .completed, "run \(run): \(journal.sources[0].error ?? "")")
            assertConserved(start, mint, lightning, journal)
        }
    }
}

// MARK: - NWC protocol

private struct ScriptedTransport: NWCTransport {
    let walletSecret: Data
    let reply: @Sendable (NostrEvent, [String: Any]) throws -> [NostrEvent]
    let calls: CallLog

    final class CallLog: @unchecked Sendable {
        private let lock = NSLock()
        private(set) var relays: [String] = []
        func add(_ relay: String) { lock.withLock { relays.append(relay) } }
    }

    func exchange(
        request: NostrEvent, relay: String, walletPublicKey: String, clientPublicKey: String,
        timeout: Duration, accept: @escaping @Sendable (NostrEvent) async -> Bool
    ) async throws -> NostrEvent {
        calls.add(relay)
        let body = try NIP04.decrypt(request.content, privateKey: walletSecret, publicKey: request.publicKey)
        let object = try JSONSerialization.jsonObject(with: Data(body.utf8)) as! [String: Any]
        for event in try reply(request, object) where await accept(event) {
            return event
        }
        throw NWCError.timedOut
    }
}

private func walletResponse(secret: Data, to request: NostrEvent, _ payload: [String: Any], eTag: String? = nil) throws -> NostrEvent {
    let json = String(decoding: try JSONSerialization.data(withJSONObject: payload), as: UTF8.self)
    return try NostrEvent.signed(
        privateKey: secret,
        createdAt: Int(Date().timeIntervalSince1970),
        kind: 23_195,
        tags: [["p", request.publicKey], ["e", eTag ?? request.id]],
        content: try NIP04.encrypt(json, privateKey: secret, publicKey: request.publicKey)
    )
}

final class NWCClientTests: XCTestCase {
    private let walletSecret = Data(repeating: 0x22, count: 32)
    private let clientSecret = Data(repeating: 0x11, count: 32)
    private var walletPub: String { "466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27" }

    private func connection(relays: [String] = ["wss://relay.one"]) throws -> NWCConnection {
        let relayQuery = relays.map { "relay=\($0.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)" }.joined(separator: "&")
        return try NWCConnection(uri: "nostr+walletconnect://\(walletPub)?\(relayQuery)&secret=\(clientSecret.hexString)&lud16=me%40wallet.example")
    }

    func testNIP04InteroperatesWithNostrTools() throws {
        // Produced by nostr-tools nip04.encrypt(sk=0x11…, pk(0x22…)).
        let ciphertext = "5HCCeRp3b9VD6LJtJT6XVBlkxzdzjl4cxWQuzDHD8j9et44uSoDZy0YUkT/nu9/miVudNXYhZlI3gnYZzqNQqQ==?iv=kKpeBP5BrPdwgun5XcgcHg=="
        let plain = try NIP04.decrypt(ciphertext, privateKey: walletSecret, publicKey: "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa")
        XCTAssertEqual(plain, #"{"result_type":"get_info","result":{"alias":"Vector"}}"#)
        let roundTrip = try NIP04.encrypt("hello", privateKey: clientSecret, publicKey: walletPub)
        XCTAssertEqual(try NIP04.decrypt(roundTrip, privateKey: walletSecret, publicKey: "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa"), "hello")
    }

    func testConnectionParsing() throws {
        let parsed = try connection(relays: ["wss://relay.one", "wss://relay.two"])
        XCTAssertEqual(parsed.walletPublicKey, walletPub)
        XCTAssertEqual(parsed.relays, ["wss://relay.one", "wss://relay.two"])
        XCTAssertEqual(parsed.walletLightningAddress, "me@wallet.example")
        XCTAssertEqual(parsed.clientPublicKey, "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa")
        XCTAssertThrowsError(try NWCConnection(uri: "https://example.com"))
        XCTAssertThrowsError(try NWCConnection(uri: "nostr+walletconnect://\(walletPub)?secret=\(clientSecret.hexString)"))
        XCTAssertThrowsError(try NWCConnection(uri: "nostr+walletconnect://\(walletPub)?relay=wss%3A%2F%2Fr"))
    }

    func testBolt11Amounts() throws {
        XCTAssertEqual(try Bolt11Amount.millisatoshis("lnbc210n1pabc"), 21_000)
        XCTAssertEqual(try Bolt11Amount.millisatoshis("LIGHTNING:lnbc1u1pabc"), 100_000)
        XCTAssertEqual(try Bolt11Amount.millisatoshis("lnbcrt5000n1pabc"), 500_000)
        XCTAssertEqual(try Bolt11Amount.millisatoshis("lntb10p1pabc"), 1)
        XCTAssertNil(try Bolt11Amount.millisatoshis("lnbc1pabc"))
        XCTAssertThrowsError(try Bolt11Amount.millisatoshis("lnbc15p1pabc"))
        XCTAssertThrowsError(try Bolt11Amount.millisatoshis("hello"))
    }

    func testIgnoresStaleAndForgedResponses() async throws {
        let secret = walletSecret
        let impostor = Data(repeating: 0x33, count: 32)
        let transport = ScriptedTransport(walletSecret: secret, reply: { request, _ in
            [
                try walletResponse(secret: secret, to: request, ["result": ["invoice": "lnbc10n1stale"]], eTag: String(repeating: "f", count: 64)),
                try walletResponse(secret: impostor, to: request, ["result": ["invoice": "lnbc210n1forged"]]),
                try walletResponse(secret: secret, to: request, ["result": ["invoice": "lnbc210n1right", "payment_hash": String(repeating: "a", count: 64)]]),
            ]
        }, calls: .init())
        let client = NWCClient(connection: try connection(), transport: transport)
        let invoice = try await client.makeInvoice(amountMsat: 21_000, description: nil)
        XCTAssertEqual(invoice.invoice, "lnbc210n1right")
        XCTAssertEqual(invoice.paymentHash, String(repeating: "a", count: 64))
    }

    func testRejectsInvoicesForTheWrongAmount() async throws {
        let secret = walletSecret
        let transport = ScriptedTransport(walletSecret: secret, reply: { request, _ in
            [try walletResponse(secret: secret, to: request, ["result": ["invoice": "lnbc220n1pwrong"]])]
        }, calls: .init())
        let client = NWCClient(connection: try connection(), transport: transport)
        do {
            _ = try await client.makeInvoice(amountMsat: 21_000, description: nil)
            XCTFail("expected mismatch")
        } catch let error as NWCError {
            XCTAssertEqual(error, .invoiceAmountMismatch(expected: 21, actual: 22))
        }
    }

    func testWalletErrorsSurfaceWithoutTryingOtherRelays() async throws {
        let secret = walletSecret
        let log = ScriptedTransport.CallLog()
        let transport = ScriptedTransport(walletSecret: secret, reply: { request, body in
            XCTAssertEqual(body["method"] as? String, "pay_invoice")
            return [try walletResponse(secret: secret, to: request, ["error": ["code": "INSUFFICIENT_BALANCE", "message": "not enough"]])]
        }, calls: log)
        let client = NWCClient(connection: try connection(relays: ["wss://a", "wss://b"]), transport: transport)
        do {
            _ = try await client.payInvoice("lnbc10n1x")
            XCTFail("expected wallet error")
        } catch let error as NWCError {
            XCTAssertEqual(error, .walletError(code: "INSUFFICIENT_BALANCE", message: "not enough"))
        }
        XCTAssertEqual(log.relays, ["wss://a"])
    }

    func testTimedOutPaymentIsNotResentThroughAnotherRelay() async throws {
        let log = ScriptedTransport.CallLog()
        let transport = ScriptedTransport(walletSecret: walletSecret, reply: { _, _ in [] }, calls: log)
        let client = NWCClient(connection: try connection(relays: ["wss://a", "wss://b"]), transport: transport)
        do {
            _ = try await client.payInvoice("lnbc10n1x", timeout: .milliseconds(10))
            XCTFail("expected timeout")
        } catch let error as NWCError {
            XCTAssertEqual(error, .timedOut)
        }
        XCTAssertEqual(log.relays, ["wss://a"])

        // Read-only requests may try the next relay.
        let readLog = ScriptedTransport.CallLog()
        let readTransport = ScriptedTransport(walletSecret: walletSecret, reply: { _, _ in [] }, calls: readLog)
        let readClient = NWCClient(connection: try connection(relays: ["wss://a", "wss://b"]), transport: readTransport)
        _ = try? await readClient.getInfo()
        XCTAssertEqual(readLog.relays, ["wss://a", "wss://b"])
    }
}

private final class MemoryNWCConnectionStore: NWCConnectionStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?

    init(_ value: String? = nil) { self.value = value }

    func load() -> String? { lock.withLock { value } }
    func save(_ uri: String) throws { lock.withLock { value = uri } }
    func delete() { lock.withLock { value = nil } }
}

final class NWCWalletCatalogTests: XCTestCase {
    private let walletSecret = Data(repeating: 0x22, count: 32)
    private let walletPub = "466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27"

    private func uri(secretByte: UInt8, address: String) -> String {
        let secret = Data(repeating: secretByte, count: 32).hexString
        return "nostr+walletconnect://\(walletPub)?relay=wss%3A%2F%2Frelay.example&secret=\(secret)&lud16=\(address.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)"
    }

    private func transport() -> ScriptedTransport {
        let secret = walletSecret
        return ScriptedTransport(walletSecret: secret, reply: { request, body in
            let method = body["method"] as? String
            let result: [String: Any] = method == "get_balance"
                ? ["balance": 42_000]
                : ["alias": "Test Node", "methods": ["pay_invoice", "make_invoice", "get_balance"]]
            return [try walletResponse(secret: secret, to: request, ["result": result])]
        }, calls: .init())
    }

    func testStoresSelectsAndEditsMultipleWallets() async throws {
        let store = MemoryNWCConnectionStore()
        let service = NWCWalletService(
            store: store,
            journalURL: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString),
            transport: transport()
        )

        _ = try await service.connect(uri: uri(secretByte: 0x11, address: "one@wallet.example"), name: "Personal")
        let firstActiveID = await service.activeWalletID
        let firstID = try XCTUnwrap(firstActiveID)
        _ = try await service.connect(uri: uri(secretByte: 0x12, address: "two@wallet.example"), name: "Work")
        let secondActiveID = await service.activeWalletID
        let secondID = try XCTUnwrap(secondActiveID)

        XCTAssertNotEqual(firstID, secondID)
        var wallets = await service.wallets
        XCTAssertEqual(wallets.map(\.name), ["Personal", "Work"])
        _ = try await service.selectWallet(id: firstID)
        try await service.setReceiveAddress("tips@example.com", for: firstID)
        try await service.renameWallet(id: firstID, name: "Everyday")

        var activeID = await service.activeWalletID
        wallets = await service.wallets
        let activeURI = await service.activeConnectionURI
        XCTAssertEqual(activeID, firstID)
        XCTAssertEqual(wallets.first?.name, "Everyday")
        XCTAssertEqual(wallets.first?.displayedReceiveAddress, "tips@example.com")
        XCTAssertTrue(activeURI?.contains("secret=") == true)

        await service.removeWallet(id: firstID)
        activeID = await service.activeWalletID
        wallets = await service.wallets
        XCTAssertEqual(activeID, secondID)
        XCTAssertEqual(wallets.map(\.name), ["Work"])
    }

    func testMigratesLegacySingleConnectionWithoutExposingItsSecretInSummary() async throws {
        let legacy = uri(secretByte: 0x11, address: "legacy@wallet.example")
        let service = NWCWalletService(
            store: MemoryNWCConnectionStore(legacy),
            journalURL: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString),
            transport: transport()
        )
        let wallets = await service.wallets
        let saved = try XCTUnwrap(wallets.first)
        XCTAssertEqual(saved.displayedReceiveAddress, "legacy@wallet.example")
        XCTAssertFalse(String(describing: saved).contains(Data(repeating: 0x11, count: 32).hexString))
    }
}
