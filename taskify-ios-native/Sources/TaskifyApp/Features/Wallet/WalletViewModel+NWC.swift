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

    var activeNWCWallet: NWCWalletSummary? {
        nwcWallets.first { $0.id == activeNWCWalletID }
    }

    var nwcWalletLabel: String { activeNWCWallet?.name ?? nwcStatus?.label ?? "NWC wallet" }

    /// Shown in place of the NWC balance when it isn't known. Never a 0: an unreachable wallet
    /// showing 0 looks like the funds are gone.
    static let unknownBalanceText = "—"

    /// Why the NWC balance is blank, or nil when it's known or still loading.
    var nwcBalanceUnavailableReason: String? {
        guard let status = nwcStatus, status.balanceSat == nil else { return nil }
        return status.info == nil ? "Can't reach \(nwcWalletLabel)" : "Balance unavailable"
    }

    /// Address shown on Receive: the user's choice, else the wallet's own lud16.
    var nwcReceiveAddress: String? {
        activeNWCWallet?.displayedReceiveAddress ?? nwcStatus?.connection.walletLightningAddress
    }

    var ecashMintBalances: [CashuMintSummary] {
        snapshot.mints.filter { $0.available > 0 }
    }

    func refreshNWC() async {
        nwcWallets = await nwcService.wallets
        activeNWCWalletID = await nwcService.activeWalletID
        nwcConnected = !nwcWallets.isEmpty
        guard nwcConnected else {
            nwcStatus = nil
            nwcReceiveAddressOverride = nil
            return
        }
        if let status = await nwcService.status() { nwcStatus = status }
        nwcReceiveAddressOverride = activeNWCWallet?.receiveAddress
        nwcMigrationJournal = await nwcService.lastMigrationJournal
    }

    func connectNWC(uri: String, name: String? = nil) async throws {
        isWorking = true
        defer { isWorking = false }
        nwcStatus = try await nwcService.connect(uri: uri, name: name)
        await refreshNWC()
        setWalletMode(.nwc)
    }

    func disconnectNWC(id: String? = nil) async {
        if let id {
            await nwcService.removeWallet(id: id)
        } else {
            await nwcService.disconnect()
        }
        await refreshNWC()
        if nwcWallets.isEmpty {
            // Without a connection there's no NWC wallet to use.
            setWalletMode(.ecash)
        } else if walletMode == .nwc {
            await refreshNWC()
        }
    }

    func selectNWCWallet(id: String) async throws {
        _ = try await nwcService.selectWallet(id: id)
        await refreshNWC()
        setWalletMode(.nwc)
    }

    func renameNWCWallet(id: String, name: String) async throws {
        try await nwcService.renameWallet(id: id, name: name)
        await refreshNWC()
    }

    func setWalletMode(_ mode: TaskifyWalletMode) {
        NWCWalletSettings().setMode(mode)
        walletMode = mode
        statusMessage = mode == .nwc ? "Using \(nwcWalletLabel)" : "Using the ecash wallet"
        Task { await refresh() }
    }

    func setNWCReceiveAddress(_ address: String?) async throws {
        guard let activeNWCWalletID else {
            throw NWCError.invalidConnection("Select an NWC wallet first.")
        }
        try await setNWCReceiveAddress(address, for: activeNWCWalletID)
    }

    func setNWCReceiveAddress(_ address: String?, for walletID: String) async throws {
        let trimmed = address?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        if !trimmed.isEmpty, !LnurlPayClient.isLightningAddress(trimmed) {
            throw NWCError.invalidConnection("Enter a lightning address like name@example.com")
        }
        let value = trimmed.isEmpty ? nil : trimmed
        try await nwcService.setReceiveAddress(value, for: walletID)
        if walletID == activeNWCWalletID { nwcReceiveAddressOverride = value }
        nwcWallets = await nwcService.wallets
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

    /// Pays an invoice created by the selected NWC wallet from one eCash mint.
    func swapEcashToNWC(amount: UInt64, sourceMintURL: String) async throws {
        let invoice = try await createNWCInvoice(amount: amount)
        let quote = try await prepareLightningPayment(
            mintURL: sourceMintURL,
            invoice: invoice.invoice,
            amount: nil
        )
        _ = try await confirmLightningPayment(quote)
        await refreshNWC()
        statusMessage = "Moved \(formattedSats(amount)) to \(nwcWalletLabel)"
    }

    /// Pays a mint invoice from the selected NWC wallet. The normal outstanding-invoice monitor
    /// finishes minting if issuance is not immediate.
    func swapNWCToEcash(amount: UInt64, destinationMintURL: String) async throws {
        let quote = try await createLightningReceiveQuote(mintURL: destinationMintURL, amount: amount)
        _ = try await payWithNWC(invoice: quote.invoice)
        _ = try? await checkLightningReceiveQuote(id: quote.id)
        await refresh()
        statusMessage = "Moved \(formattedSats(amount)) to Taskify eCash"
    }

    func setSolifeNWCForward(handle: String, connection: String) async throws {
        guard let identity = try? KeychainIdentityStore().load() else { throw SolifeError.authenticationFailed }
        _ = try await SolifeClient.setNWCForward(identity: identity, handle: handle, connection: connection)
        await refreshSolifeAccount()
    }

    /// Explicit opt-in path: share the active Taskify NWC connection with solife.me so it can
    /// create invoices for this address. The server restricts itself to get_info/make_invoice.
    func shareActiveNWCWithSolife(handle: String) async throws {
        guard let connection = await nwcService.activeConnectionURI else {
            throw NWCError.invalidConnection("Select an NWC wallet first.")
        }
        try await setSolifeNWCForward(handle: handle, connection: connection)
    }

    func clearSolifeNWCForward(handle: String) async throws {
        guard let identity = try? KeychainIdentityStore().load() else { throw SolifeError.authenticationFailed }
        _ = try await SolifeClient.clearNWCForward(identity: identity, handle: handle)
        await refreshSolifeAccount()
    }
}
