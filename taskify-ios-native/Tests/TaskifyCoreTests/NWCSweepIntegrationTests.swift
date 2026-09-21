import Foundation
import XCTest
@testable import TaskifyCore

/// End-to-end sweep with the real CDK wallet against nutshell mints (FakeWallet backend).
/// Skipped unless CASHU_TEST_MINT_A and CASHU_TEST_MINT_B are set, e.g.
///
///   CASHU_TEST_MINT_A=http://127.0.0.1:3391 CASHU_TEST_MINT_B=http://127.0.0.1:3392 \
///     swift test --scratch-path /tmp/spm --filter NWCSweepIntegrationTests
///
/// Mint A holds the ecash (run it with MINT_INPUT_FEE_PPK > 0). Mint B stands in for the
/// NWC wallet: its mint quotes are the invoices the sweep pays.
final class NWCSweepIntegrationTests: XCTestCase {
    private var mintA = ProcessInfo.processInfo.environment["CASHU_TEST_MINT_A"] ?? ""
    private var mintB = ProcessInfo.processInfo.environment["CASHU_TEST_MINT_B"] ?? ""
    private var directory: URL!

    override func setUpWithError() throws {
        try XCTSkipIf(mintA.isEmpty || mintB.isEmpty, "Set CASHU_TEST_MINT_A and CASHU_TEST_MINT_B to run")
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("nwc-sweep-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let directory { try? FileManager.default.removeItem(at: directory) }
    }

    private func makeService() throws -> CashuWalletService {
        try CashuWalletService(
            databaseURL: directory.appendingPathComponent("wallet.sqlite"),
            outgoingTokensURL: directory.appendingPathComponent("outgoing.json"),
            mnemonic: try CashuWalletService.generateMnemonic()
        )
    }

    private func fund(_ service: CashuWalletService, amounts: [UInt64]) async throws {
        try await service.addMint(mintA)
        for amount in amounts {
            let quote = try await service.createLightningReceiveQuote(mintURL: mintA, amount: amount)
            var claimed = false
            for _ in 0..<30 {
                if let checked = try? await service.checkAndClaimLightningReceiveQuote(id: quote.id),
                   checked.state == .issued {
                    claimed = true
                    break
                }
                try await Task.sleep(for: .milliseconds(200))
            }
            XCTAssertTrue(claimed, "mint A did not issue \(amount) sats")
        }
    }

    /// Mint B's mint quotes play the NWC wallet's make_invoice.
    private struct MintBDestination: SweepDestination {
        let mintURL: String

        func makeInvoice(amountSat: UInt64, memo: String) async throws -> NWCInvoice {
            var request = URLRequest(url: URL(string: "\(mintURL)/v1/mint/quote/bolt11")!)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["amount": amountSat, "unit": "sat"])
            let (data, _) = try await URLSession.shared.data(for: request)
            let body = try JSONSerialization.jsonObject(with: data) as! [String: Any]
            return NWCInvoice(invoice: body["request"] as! String, paymentHash: nil)
        }

        func lookupInvoice(paymentHash: String?, invoice: String) async -> NWCInvoiceStatus? { nil }
    }

    func testSweepsTheWholeBalanceThroughCDK() async throws {
        let service = try makeService()
        try await fund(service, amounts: [2_100, 1_500, 1_337])
        let start = try await service.balance(mintURL: mintA).spendable
        XCTAssertEqual(start, 4_937)

        let store = FileSweepJournalStore(url: directory.appendingPathComponent("journal.json"))
        var options = SweepOptions()
        options.lookupAttempts = 0
        let journal = await runSweep(
            sources: [CashuMintSweepSource(service: service, mintURL: mintA)],
            destination: MintBDestination(mintURL: mintB),
            store: store,
            options: options
        )

        let record = journal.sources[0]
        XCTAssertEqual(journal.status, .completed, record.error ?? "")
        let after = try await service.balance(mintURL: mintA)
        XCTAssertEqual(after.pending, 0, "no inputs should be left reserved")
        XCTAssertEqual(record.sentSat + record.feesSat + after.spendable, start)
        XCTAssertLessThan(after.spendable, 10, "only returned fee reserve should remain")
        XCTAssertEqual(store.load()?.runID, journal.runID, "journal persisted to disk")
    }

    func testTokenLimitedSweepLeavesOtherEcashAlone() async throws {
        let service = try makeService()
        try await fund(service, amounts: [3_000])
        var options = SweepOptions()
        options.lookupAttempts = 0
        options.maxPasses = 1
        let journal = await runSweep(
            sources: [CashuMintSweepSource(service: service, mintURL: mintA, limitSat: 1_000)],
            destination: MintBDestination(mintURL: mintB),
            store: FileSweepJournalStore(url: directory.appendingPathComponent("journal.json")),
            options: options
        )
        let record = journal.sources[0]
        XCTAssertEqual(journal.status, .completed, record.error ?? "")
        XCTAssertLessThanOrEqual(record.sentSat + record.feesSat, 1_000)
        let after = try await service.balance(mintURL: mintA)
        XCTAssertEqual(after.spendable + record.sentSat + record.feesSat, 3_000)
        XCTAssertGreaterThanOrEqual(after.spendable, 2_000)
    }

    func testUnaffordableQuoteReservesNothing() async throws {
        let service = try makeService()
        try await fund(service, amounts: [500])
        let destination = MintBDestination(mintURL: mintB)
        let invoice = try await destination.makeInvoice(amountSat: 499, memo: "")
        let result = try await service.prepareLightningPayment(mintURL: mintA, invoice: invoice.invoice, budget: 500)
        guard case let .unaffordable(_, amount, feeReserve, _) = result else {
            return XCTFail("expected unaffordable, got \(result)")
        }
        XCTAssertEqual(amount, 499)
        XCTAssertGreaterThan(feeReserve, 0)
        let balance = try await service.balance(mintURL: mintA)
        XCTAssertEqual(balance.spendable, 500)
        XCTAssertEqual(balance.pending, 0)
    }
}
