import Foundation
import TaskifyCore
#if canImport(UIKit)
import UIKit
#endif

// Shared by the iOS and macOS apps (the Mac target compiles WalletView.swift too).

// MARK: - View model: NWC wallet mode

extension WalletViewModel {
    static var nwcJournalURL: URL {
        let base = (try? FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )) ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("TaskifyNative/nwc-sweep-journal.json")
    }

    /// An NWC wallet replaces the ecash wallet for sending and receiving.
    var isNWCWalletActive: Bool { walletMode == .nwc && nwcConnected }

    var nwcWalletLabel: String { nwcStatus?.label ?? "NWC wallet" }

    /// Address shown on Receive: the user's choice, else the wallet's own lud16.
    var nwcReceiveAddress: String? {
        nwcReceiveAddressOverride ?? nwcStatus?.connection.walletLightningAddress
    }

    var ecashMintBalances: [CashuMintSummary] {
        snapshot.mints.filter { $0.available > 0 }
    }

    func refreshNWC() async {
        nwcConnected = await nwcService.connection != nil
        guard nwcConnected else {
            nwcStatus = nil
            return
        }
        if let status = await nwcService.status() { nwcStatus = status }
        nwcMigrationJournal = await nwcService.lastMigrationJournal
    }

    func connectNWC(uri: String) async throws {
        isWorking = true
        defer { isWorking = false }
        nwcStatus = try await nwcService.connect(uri: uri)
        nwcConnected = true
    }

    func disconnectNWC() async {
        await nwcService.disconnect()
        nwcConnected = false
        nwcStatus = nil
        // Without a connection there's no NWC wallet to use.
        setWalletMode(.ecash)
    }

    func setWalletMode(_ mode: TaskifyWalletMode) {
        NWCWalletSettings().setMode(mode)
        walletMode = mode
        statusMessage = mode == .nwc ? "Using \(nwcWalletLabel)" : "Using the ecash wallet"
        Task { await refresh() }
    }

    func setNWCReceiveAddress(_ address: String?) throws {
        let trimmed = address?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        if !trimmed.isEmpty, !LnurlPayClient.isLightningAddress(trimmed) {
            throw NWCError.invalidConnection("Enter a lightning address like name@example.com")
        }
        let value = trimmed.isEmpty ? nil : trimmed
        NWCWalletSettings().setReceiveAddress(value)
        nwcReceiveAddressOverride = value
    }

    /// Moves every mint's ecash balance to the NWC wallet.
    func migrateToNWC() async -> SweepJournal? {
        guard let service else { return nil }
        isMovingToNWC = true
        defer { isMovingToNWC = false }
        do {
            let journal = try await nwcService.migrate(from: service) { journal in
                Task { @MainActor [weak self] in self?.nwcMigrationJournal = journal }
            }
            nwcMigrationJournal = journal
            let summary = journal.summary
            if summary.sentSat > 0 {
                statusMessage = "Moved \(formattedSats(summary.sentSat)) to \(nwcWalletLabel)"
            }
            await refresh()
            await refreshNWC()
            return journal
        } catch {
            errorMessage = Self.message(for: error)
            return nil
        }
    }

    /// Redeems a saved token and moves what it brought in to the NWC wallet.
    func moveTokenToNWC(_ pending: CashuPendingReceive) async {
        guard let service else { return }
        isMovingToNWC = true
        defer { isMovingToNWC = false }
        do {
            let journal = try await nwcService.moveSavedToken(pending, from: service)
            let record = journal.sources.first
            if journal.status == .completed, let sent = record?.sentSat, sent > 0 {
                statusMessage = "Moved \(formattedSats(sent)) to \(nwcWalletLabel)"
            } else if let error = record?.error {
                errorMessage = "The token was received into your ecash wallet but couldn't be moved yet: \(error)"
            } else if journal.hasUnsettledMelts {
                statusMessage = "The payment is still settling; check again shortly."
            }
        } catch {
            errorMessage = Self.message(for: error)
        }
        await refresh()
        await refreshNWC()
    }

    func payWithNWC(invoice: String) async throws -> NWCPayment {
        isWorking = true
        defer { isWorking = false }
        let payment = try await nwcService.pay(invoice: invoice)
        statusMessage = "Payment sent"
        #if canImport(UIKit)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        #endif
        await refreshNWC()
        return payment
    }

    func createNWCInvoice(amount: UInt64) async throws -> NWCInvoice {
        isWorking = true
        defer { isWorking = false }
        return try await nwcService.createInvoice(amountSat: amount, description: "Taskify")
    }

    func isNWCInvoiceSettled(_ invoice: NWCInvoice) async -> Bool {
        (try? await nwcService.invoiceStatus(invoice).settled) ?? false
    }

    func nwcTransactions() async throws -> [NWCTransaction] {
        try await nwcService.transactions()
    }

    func setSolifeNWCForward(handle: String, connection: String) async throws {
        guard let identity = try? KeychainIdentityStore().load() else { throw SolifeError.authenticationFailed }
        _ = try await SolifeClient.setNWCForward(identity: identity, handle: handle, connection: connection)
        await refreshSolifeAccount()
    }

    func clearSolifeNWCForward(handle: String) async throws {
        guard let identity = try? KeychainIdentityStore().load() else { throw SolifeError.authenticationFailed }
        _ = try await SolifeClient.clearNWCForward(identity: identity, handle: handle)
        await refreshSolifeAccount()
    }
}
