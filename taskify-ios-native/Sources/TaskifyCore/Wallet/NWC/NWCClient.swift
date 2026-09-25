import TaskifyWatchShared
import Foundation

public struct NWCWalletInfo: Equatable, Sendable {
    public let alias: String?
    public let methods: [String]

    public init(alias: String?, methods: [String]) {
        self.alias = alias
        self.methods = methods
    }
}

public struct NWCInvoice: Equatable, Sendable {
    public let invoice: String
    public let paymentHash: String?

    public init(invoice: String, paymentHash: String?) {
        self.invoice = invoice
        self.paymentHash = paymentHash
    }
}

public struct NWCInvoiceStatus: Equatable, Sendable {
    public let settled: Bool
    public let preimage: String?

    public init(settled: Bool, preimage: String?) {
        self.settled = settled
        self.preimage = preimage
    }
}

public struct NWCPayment: Equatable, Sendable {
    public let preimage: String?
    public let feesPaidMsat: UInt64?

    public init(preimage: String?, feesPaidMsat: UInt64?) {
        self.preimage = preimage
        self.feesPaidMsat = feesPaidMsat
    }
}

public struct NWCTransaction: Identifiable, Equatable, Sendable {
    public enum Direction: String, Sendable { case incoming, outgoing }

    public var id: String { paymentHash ?? "\(createdAt.timeIntervalSince1970)-\(amountSat)" }
    public let direction: Direction
    public let amountSat: UInt64
    public let feesSat: UInt64
    public let description: String?
    public let paymentHash: String?
    public let createdAt: Date
    public let settledAt: Date?

    public init(direction: Direction, amountSat: UInt64, feesSat: UInt64, description: String?, paymentHash: String?, createdAt: Date, settledAt: Date?) {
        self.direction = direction
        self.amountSat = amountSat
        self.feesSat = feesSat
        self.description = description
        self.paymentHash = paymentHash
        self.createdAt = createdAt
        self.settledAt = settledAt
    }
}

/// Carries one signed NIP-47 request to a relay and returns the first response event the
/// caller accepts. Implementations must subscribe before publishing.
public protocol NWCTransport: Sendable {
    func exchange(
        request: NostrEvent,
        relay: String,
        walletPublicKey: String,
        clientPublicKey: String,
        timeout: Duration,
        accept: @escaping @Sendable (NostrEvent) async -> Bool
    ) async throws -> NostrEvent
}

public struct RelayNWCTransport: NWCTransport {
    private let authenticationIdentity: NostrIdentity?
    public init(authenticationIdentity: NostrIdentity? = nil) { self.authenticationIdentity = authenticationIdentity }

    public func exchange(
        request: NostrEvent,
        relay: String,
        walletPublicKey: String,
        clientPublicKey: String,
        timeout: Duration,
        accept: @escaping @Sendable (NostrEvent) async -> Bool
    ) async throws -> NostrEvent {
        let connection = NostrRelayConnection(relayURL: relay, authenticationIdentity: authenticationIdentity)
        do {
            try await connection.connect()
        } catch {
            throw NWCError.relayUnavailable
        }
        defer { Task { await connection.disconnect() } }
        let subscriptionID = "nwc-\(request.id.prefix(12))"
        try await connection.subscribeToNWCResponses(
            id: subscriptionID,
            walletPublicKey: walletPublicKey,
            clientPublicKey: clientPublicKey,
            requestID: request.id
        )
        try await connection.publish(request)

        return try await withThrowingTaskGroup(of: NostrEvent?.self) { group in
            group.addTask {
                for await message in connection.messages() {
                    switch message {
                    case let .event(_, event):
                        if await accept(event) { return event }
                    case .disconnected:
                        throw NWCError.relayUnavailable
                    default:
                        continue
                    }
                }
                throw NWCError.relayUnavailable
            }
            group.addTask {
                try await Task.sleep(for: timeout)
                return nil
            }
            defer { group.cancelAll() }
            guard let first = try await group.next(), let event = first else {
                throw NWCError.timedOut
            }
            return event
        }
    }
}

/// A Nostr Wallet Connect (NIP-47) client for one connection.
public actor NWCClient {
    public static let spendMethods: Set<String> = ["pay_invoice", "multi_pay_invoice", "pay_keysend", "multi_pay_keysend"]

    public nonisolated let connection: NWCConnection
    private let transport: NWCTransport

    public init(connection: NWCConnection, transport: NWCTransport? = nil) {
        self.connection = connection
        self.transport = transport ?? RelayNWCTransport(authenticationIdentity: try? NostrIdentity(privateKey: connection.clientSecretKey))
    }

    public func getInfo() async throws -> NWCWalletInfo {
        let result = try await request(method: "get_info", params: [:])
        let methods = (result["methods"] as? [Any])?.compactMap { $0 as? String } ?? []
        let alias = (result["alias"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return NWCWalletInfo(alias: alias?.isEmpty == false ? alias : nil, methods: methods)
    }

    public func getBalanceMsat() async throws -> UInt64 {
        let result = try await request(method: "get_balance", params: [:])
        guard let balance = Self.unsigned(result["balance"]) else { throw NWCError.invalidResponse }
        return balance
    }

    /// Creates an invoice and refuses it unless it's for exactly `amountMsat`.
    public func makeInvoice(amountMsat: UInt64, description: String?) async throws -> NWCInvoice {
        var params: [String: Any] = ["amount": amountMsat]
        if let description, !description.isEmpty { params["description"] = description }
        let result = try await request(method: "make_invoice", params: params)
        guard let invoice = (result["invoice"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !invoice.isEmpty else { throw NWCError.invalidResponse }
        let invoiceMsat = try? Bolt11Amount.millisatoshis(invoice)
        guard invoiceMsat == amountMsat else {
            throw NWCError.invoiceAmountMismatch(expected: amountMsat / 1_000, actual: invoiceMsat.map { $0 / 1_000 })
        }
        let hash = (result["payment_hash"] as? String)?.lowercased()
        let validHash = hash.flatMap { $0.count == 64 && $0.allSatisfy(\.isHexDigit) ? $0 : nil }
        return NWCInvoice(invoice: invoice, paymentHash: validHash)
    }

    public func lookupInvoice(paymentHash: String?, invoice: String) async throws -> NWCInvoiceStatus {
        let params: [String: Any] = paymentHash.map { ["payment_hash": $0] } ?? ["invoice": invoice]
        let result = try await request(method: "lookup_invoice", params: params)
        let state = (result["state"] as? String)?.lowercased()
        let settledAt = Self.unsigned(result["settled_at"]) ?? 0
        return NWCInvoiceStatus(
            settled: state == "settled" || settledAt > 0,
            preimage: result["preimage"] as? String
        )
    }

    /// Settled transactions, newest first (NIP-47 list_transactions).
    public func listTransactions(limit: Int = 50) async throws -> [NWCTransaction] {
        let result = try await request(method: "list_transactions", params: ["limit": limit])
        let items = result["transactions"] as? [[String: Any]] ?? []
        return items.compactMap { item in
            guard let type = item["type"] as? String,
                  let direction = NWCTransaction.Direction(rawValue: type),
                  let amount = Self.unsigned(item["amount"]) else { return nil }
            let created = Self.unsigned(item["created_at"]).map { Date(timeIntervalSince1970: TimeInterval($0)) } ?? Date()
            let settled = Self.unsigned(item["settled_at"]).flatMap { $0 > 0 ? Date(timeIntervalSince1970: TimeInterval($0)) : nil }
            return NWCTransaction(
                direction: direction,
                amountSat: amount / 1_000,
                feesSat: (Self.unsigned(item["fees_paid"]) ?? 0) / 1_000,
                description: item["description"] as? String,
                paymentHash: item["payment_hash"] as? String,
                createdAt: created,
                settledAt: settled
            )
        }
        .sorted { $0.createdAt > $1.createdAt }
    }

    /// Pays an invoice. A timeout doesn't mean failure: callers must check the invoice's
    /// status before telling the user to retry. Never re-sent through another relay.
    public func payInvoice(_ invoice: String, timeout: Duration = .seconds(90)) async throws -> NWCPayment {
        let result = try await request(method: "pay_invoice", params: ["invoice": invoice], timeout: timeout)
        return NWCPayment(preimage: result["preimage"] as? String, feesPaidMsat: Self.unsigned(result["fees_paid"]))
    }

    private func request(
        method: String,
        params: [String: Any],
        timeout: Duration = .seconds(20)
    ) async throws -> [String: Any] {
        let payload = try JSONSerialization.data(withJSONObject: ["method": method, "params": params])
        let content = try NIP04.encrypt(
            String(decoding: payload, as: UTF8.self),
            privateKey: connection.clientSecretKey,
            publicKey: connection.walletPublicKey
        )
        let signingConnection = connection
        let request = try await TaskifyRelayProofOfWork.prepare(relays: connection.relays) {
            try NostrEvent.signed(
            privateKey: signingConnection.clientSecretKey,
            createdAt: Int(Date().timeIntervalSince1970),
            kind: 23_194,
            tags: [["p", signingConnection.walletPublicKey]],
            content: content
        )
        }
        let walletKey = connection.walletPublicKey
        let clientSecret = connection.clientSecretKey
        let requestID = request.id
        let accept: @Sendable (NostrEvent) async -> Bool = { event in
            guard event.kind == 23_195,
                  event.publicKey.lowercased() == walletKey,
                  event.firstTagValue(named: "e")?.lowercased() == requestID,
                  event.verify(),
                  (try? NIP04.decrypt(event.content, privateKey: clientSecret, publicKey: walletKey)) != nil
            else { return false }
            return true
        }

        let isPayment = Self.spendMethods.contains(method)
        var lastError: Error = NWCError.relayUnavailable
        for relay in connection.relays {
            do {
                let response = try await transport.exchange(
                    request: request,
                    relay: relay,
                    walletPublicKey: walletKey,
                    clientPublicKey: connection.clientPublicKey,
                    timeout: timeout,
                    accept: accept
                )
                return try Self.decodeResponse(response, secret: clientSecret, walletKey: walletKey)
            } catch let error as NWCError {
                if case .walletError = error { throw error }
                lastError = error
                if isPayment, error == .timedOut { throw error }
            } catch {
                lastError = error
            }
        }
        throw lastError
    }

    private static func decodeResponse(_ event: NostrEvent, secret: Data, walletKey: String) throws -> [String: Any] {
        let plaintext = try NIP04.decrypt(event.content, privateKey: secret, publicKey: walletKey)
        guard let object = try JSONSerialization.jsonObject(with: Data(plaintext.utf8)) as? [String: Any] else {
            throw NWCError.invalidResponse
        }
        if let error = object["error"] as? [String: Any] {
            let message = (error["message"] as? String) ?? (error["code"] as? String) ?? "The wallet rejected the request."
            throw NWCError.walletError(code: error["code"] as? String, message: message)
        }
        return object["result"] as? [String: Any] ?? [:]
    }

    private static func unsigned(_ value: Any?) -> UInt64? {
        switch value {
        case let number as NSNumber:
            let double = number.doubleValue
            return double >= 0 && double.isFinite ? UInt64(double) : nil
        case let string as String:
            return UInt64(string)
        default:
            return nil
        }
    }
}
