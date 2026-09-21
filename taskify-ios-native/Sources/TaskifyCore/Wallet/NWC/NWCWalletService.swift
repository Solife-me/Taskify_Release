import Foundation
import Security

/// Which wallet the app sends and receives with.
public enum TaskifyWalletMode: String, Codable, Sendable {
    /// The built-in Cashu wallet.
    case ecash
    /// An external lightning wallet over Nostr Wallet Connect. The Cashu wallet's seed and
    /// proofs are kept, and incoming ecash is saved unredeemed.
    case nwc
}

/// Where the NWC connection string (a secret) is kept.
public protocol NWCConnectionStore: Sendable {
    func load() -> String?
    func save(_ uri: String) throws
    func delete()
}

/// Keychain storage, available only after first unlock and never synced off the device.
public struct KeychainNWCConnectionStore: NWCConnectionStore {
    private let service: String
    private let account = "nwc-connection"

    public init(service: String = "solife.me.Taskify.nwc") {
        self.service = service
    }

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    public func load() -> String? {
        var query = query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func save(_ uri: String) throws {
        delete()
        var attributes = query
        attributes[kSecValueData as String] = Data(uri.utf8)
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }

    public func delete() {
        SecItemDelete(query as CFDictionary)
    }
}

/// Settings that aren't secret.
public struct NWCWalletSettings {
    private let defaults: UserDefaults
    private let modeKey = "taskify.wallet.mode"
    private let receiveAddressKey = "taskify.wallet.nwc-receive-address"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public var mode: TaskifyWalletMode {
        TaskifyWalletMode(rawValue: defaults.string(forKey: modeKey) ?? "") ?? .ecash
    }

    public func setMode(_ mode: TaskifyWalletMode) {
        defaults.set(mode.rawValue, forKey: modeKey)
    }

    /// Lightning address shown on Receive in NWC mode, overriding the wallet's own.
    public var receiveAddress: String? {
        let value = defaults.string(forKey: receiveAddressKey)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return value?.isEmpty == false ? value : nil
    }

    public func setReceiveAddress(_ address: String?) {
        defaults.set(address, forKey: receiveAddressKey)
    }
}

public struct NWCWalletStatus: Equatable, Sendable {
    public let connection: NWCConnection
    public let info: NWCWalletInfo?
    public let balanceSat: UInt64?

    public var label: String { info?.alias ?? connection.walletName ?? "NWC wallet" }
    public var missingMethods: [String] {
        guard let methods = info?.methods, !methods.isEmpty else { return [] }
        return ["pay_invoice", "make_invoice"].filter { !methods.contains($0) }
    }
}

/// Everything about using an NWC wallet instead of the Cashu wallet: the connection,
/// payments, and moving ecash into it. Shared by the iOS and macOS apps.
public actor NWCWalletService {
    private let store: any NWCConnectionStore
    private let journalURL: URL
    private let transport: any NWCTransport
    private var client: NWCClient?
    private var sweeping = false

    public init(
        store: any NWCConnectionStore = KeychainNWCConnectionStore(),
        journalURL: URL,
        transport: any NWCTransport = RelayNWCTransport()
    ) {
        self.store = store
        self.journalURL = journalURL
        self.transport = transport
        if let uri = store.load(), let connection = try? NWCConnection(uri: uri) {
            client = NWCClient(connection: connection, transport: transport)
        }
    }

    public var connection: NWCConnection? { client?.connection }

    /// Parses, checks and saves a connection. Only saved if the wallet answers.
    @discardableResult
    public func connect(uri: String) async throws -> NWCWalletStatus {
        let connection = try NWCConnection(uri: uri)
        let candidate = NWCClient(connection: connection, transport: transport)
        let info = try await candidate.getInfo()
        let balance = try? await candidate.getBalanceMsat()
        try store.save(connection.uri)
        client = candidate
        return NWCWalletStatus(connection: connection, info: info, balanceSat: balance.map { $0 / 1_000 })
    }

    public func disconnect() {
        store.delete()
        client = nil
    }

    public func status() async -> NWCWalletStatus? {
        guard let client else { return nil }
        let info = try? await client.getInfo()
        let balance = try? await client.getBalanceMsat()
        return NWCWalletStatus(connection: client.connection, info: info, balanceSat: balance.map { $0 / 1_000 })
    }

    private func requireClient() throws -> NWCClient {
        guard let client else { throw NWCError.invalidConnection("Connect an NWC wallet first.") }
        return client
    }

    /// Pays an invoice. If the wallet doesn't answer in time, asks it whether the invoice
    /// settled before reporting anything, so a slow payment is never shown as failed.
    public func pay(invoice: String) async throws -> NWCPayment {
        let client = try requireClient()
        do {
            return try await client.payInvoice(invoice)
        } catch NWCError.timedOut {
            if let status = try? await client.lookupInvoice(paymentHash: nil, invoice: invoice), status.settled {
                return NWCPayment(preimage: status.preimage, feesPaidMsat: nil)
            }
            throw NWCError.paymentUnconfirmed
        }
    }

    public func createInvoice(amountSat: UInt64, description: String?) async throws -> NWCInvoice {
        let (msat, overflow) = amountSat.multipliedReportingOverflow(by: 1_000)
        guard amountSat > 0, !overflow else { throw CashuWalletError.invalidLightningAmount }
        return try await requireClient().makeInvoice(amountMsat: msat, description: description)
    }

    public func invoiceStatus(_ invoice: NWCInvoice) async throws -> NWCInvoiceStatus {
        try await requireClient().lookupInvoice(paymentHash: invoice.paymentHash, invoice: invoice.invoice)
    }

    public func transactions(limit: Int = 50) async throws -> [NWCTransaction] {
        try await requireClient().listTransactions(limit: limit)
    }

    // MARK: Moving ecash

    public var lastMigrationJournal: SweepJournal? {
        FileSweepJournalStore(url: journalURL).load()
    }

    /// Moves every mint's balance in `cashu` to the NWC wallet, resuming an unfinished run.
    public func migrate(
        from cashu: CashuWalletService,
        onUpdate: (@Sendable (SweepJournal) -> Void)? = nil
    ) async throws -> SweepJournal {
        let client = try requireClient()
        guard !sweeping else { throw NWCError.invalidConnection("A transfer is already running.") }
        sweeping = true
        defer { sweeping = false }

        let store = FileSweepJournalStore(url: journalURL)
        let previous = store.load()
        let resume = previous?.status == .completed ? nil : previous
        var mintURLs = await cashu.snapshot().mints.filter { $0.available > 0 }.map(\.url)
        for source in resume?.sources ?? [] where !mintURLs.contains(source.sourceID) {
            mintURLs.append(source.sourceID)
        }
        var options = SweepOptions()
        options.onUpdate = onUpdate
        return await runSweep(
            sources: mintURLs.map { CashuMintSweepSource(service: cashu, mintURL: $0) },
            destination: NWCSweepDestination(client: client),
            store: store,
            journal: resume,
            options: options
        )
    }

    /// Redeems a saved token and moves exactly what it brought in to the NWC wallet. If the
    /// move fails, the sats stay in the Cashu wallet (never lost) and the error is thrown.
    public func moveSavedToken(
        _ pending: CashuPendingReceive,
        from cashu: CashuWalletService
    ) async throws -> SweepJournal {
        let client = try requireClient()
        guard !sweeping else { throw NWCError.invalidConnection("A transfer is already running.") }
        sweeping = true
        defer { sweeping = false }

        let received = try await cashu.redeemPendingReceive(id: pending.id)
        var options = SweepOptions()
        options.maxPasses = 1
        options.memo = "Taskify ecash token"
        let tokenJournal = journalURL.deletingLastPathComponent()
            .appendingPathComponent("nwc-token-sweep-\(pending.id.prefix(12)).json")
        let journal = await runSweep(
            sources: [CashuMintSweepSource(service: cashu, mintURL: pending.mintURL, limitSat: received)],
            destination: NWCSweepDestination(client: client),
            store: FileSweepJournalStore(url: tokenJournal),
            options: options
        )
        if journal.status == .completed, !journal.hasUnsettledMelts {
            FileSweepJournalStore(url: tokenJournal).clear()
        }
        return journal
    }
}
