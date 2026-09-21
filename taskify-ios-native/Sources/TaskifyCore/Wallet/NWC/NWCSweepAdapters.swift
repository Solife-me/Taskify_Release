import Foundation

/// Sweeps one mint's balance from the Cashu wallet. With `limitSat`, at most that many sats
/// are spent (used to move just a received token, not other ecash at the same mint); run
/// limited sources with a single pass.
public struct CashuMintSweepSource: SweepSource {
    public let service: CashuWalletService
    public let mintURL: String
    public let limitSat: UInt64?
    public let label: String

    public var id: String { limitSat == nil ? mintURL : "\(mintURL)#limit" }

    public init(service: CashuWalletService, mintURL: String, limitSat: UInt64? = nil, label: String? = nil) {
        self.service = service
        self.mintURL = mintURL
        self.limitSat = limitSat
        self.label = label ?? URL(string: mintURL)?.host ?? mintURL
    }

    public func plan() async throws -> SweepPlan {
        let balance = try await service.balance(mintURL: mintURL)
        let spendable = limitSat.map { min($0, balance.spendable) } ?? balance.spendable
        return SweepPlan(spendableSat: spendable, excludedSat: balance.pending &+ balance.reserved)
    }

    public func prepare(invoice: String, budgetSat: UInt64) async throws -> SweepPreparation {
        switch try await service.prepareLightningPayment(mintURL: mintURL, invoice: invoice, budget: budgetSat) {
        case let .prepared(quote):
            return SweepPreparation(
                handle: quote.id,
                quoteID: quote.quoteID,
                amountSat: quote.amount,
                feeReserveSat: quote.feeReserve,
                walletFeeSat: quote.walletFee
            )
        case let .unaffordable(quoteID, amount, feeReserve, walletFee):
            return SweepPreparation(handle: nil, quoteID: quoteID, amountSat: amount, feeReserveSat: feeReserve, walletFeeSat: walletFee)
        }
    }

    public func cancel(_ preparation: SweepPreparation) async {
        guard let handle = preparation.handle else { return }
        await service.cancelLightningPayment(id: handle)
    }

    public func confirm(_ preparation: SweepPreparation) async throws -> SweepMeltResult {
        guard let handle = preparation.handle else { throw CashuWalletError.lightningPaymentMissing }
        let before = try? await service.balance(mintURL: mintURL)
        let result = try await service.confirmLightningPayment(id: handle)
        switch result.state {
        case .completed:
            // The real total cost is what left the wallet beyond the amount paid.
            // Reserved inputs count in neither spendable nor pending, so compare full totals.
            var totalFee: UInt64?
            if let before, let after = try? await service.balance(mintURL: mintURL), after.pending == 0 {
                let beforeTotal = before.spendable + before.pending + before.reserved
                let afterTotal = after.spendable + after.pending + after.reserved
                let spent = beforeTotal.subtractingReportingOverflow(afterTotal)
                if !spent.overflow, spent.partialValue >= result.amount {
                    totalFee = spent.partialValue - result.amount
                }
            }
            return SweepMeltResult(state: .paid, preimage: result.preimage, feePaidSat: totalFee)
        case .pending:
            return SweepMeltResult(state: .pending, preimage: nil, feePaidSat: nil)
        }
    }

    public func check(quoteID: String) async -> SweepMeltResult? {
        await service.lightningPaymentStatus(mintURL: mintURL, quoteID: quoteID)
    }
}

public struct NWCSweepDestination: SweepDestination {
    public let client: NWCClient

    public init(client: NWCClient) {
        self.client = client
    }

    public func makeInvoice(amountSat: UInt64, memo: String) async throws -> NWCInvoice {
        let (msat, overflow) = amountSat.multipliedReportingOverflow(by: 1_000)
        guard amountSat > 0, !overflow else { throw CashuWalletError.invalidLightningAmount }
        return try await client.makeInvoice(amountMsat: msat, description: memo)
    }

    public func lookupInvoice(paymentHash: String?, invoice: String) async -> NWCInvoiceStatus? {
        try? await client.lookupInvoice(paymentHash: paymentHash, invoice: invoice)
    }
}
