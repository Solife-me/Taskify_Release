import Cdk
import Foundation

public enum CashuCreatedPaymentRequestState: String, Codable, Equatable, Sendable {
    case active
    case completed
    case cancelled
}

public struct CashuCreatedPaymentRequest: Identifiable, Codable, Equatable, Sendable {
    public var id: String { requestID }
    public let requestID: String
    public let encoded: String
    public let amount: UInt64?
    public let description: String?
    public let mintURLs: [String]
    public let relayURLs: [String]
    public let singleUse: Bool
    public let createdAt: Date
    public var state: CashuCreatedPaymentRequestState
    public var receivedAmount: UInt64
    public var receivedCount: Int
    public var lastReceivedAt: Date?
    public var lastSenderPublicKey: String?
    public var processedEventIDs: [String]

    public init(
        requestID: String,
        encoded: String,
        amount: UInt64?,
        description: String?,
        mintURLs: [String],
        relayURLs: [String],
        singleUse: Bool,
        createdAt: Date = Date(),
        state: CashuCreatedPaymentRequestState = .active,
        receivedAmount: UInt64 = 0,
        receivedCount: Int = 0,
        lastReceivedAt: Date? = nil,
        lastSenderPublicKey: String? = nil,
        processedEventIDs: [String] = []
    ) {
        self.requestID = requestID
        self.encoded = encoded
        self.amount = amount
        self.description = description
        self.mintURLs = mintURLs
        self.relayURLs = relayURLs
        self.singleUse = singleUse
        self.createdAt = createdAt
        self.state = state
        self.receivedAmount = receivedAmount
        self.receivedCount = receivedCount
        self.lastReceivedAt = lastReceivedAt
        self.lastSenderPublicKey = lastSenderPublicKey
        self.processedEventIDs = processedEventIDs
    }

    public var isActive: Bool { state == .active }
}

public struct CashuNostrPaymentDelivery: Identifiable, Codable, Equatable, Sendable {
    public var id: String { eventID }
    public let eventID: String
    public let payloadJSON: String
    public let senderPublicKey: String
    public let receivedAt: Date
    /// Counts `CashuWalletError.paymentRequestUncertain` results: the mint rejected the token as
    /// already spent, but nothing on this device (a matching transaction, a balance increase)
    /// shows *we* were the one who spent it -- most likely someone else redeemed it first. A
    /// couple of retries give a same-device timing race (the evidence just hasn't landed yet) a
    /// chance to resolve itself before the delivery is given up on for good; `Int?` rather than a
    /// non-optional default so old persisted deliveries without this field decode as 0 attempts.
    public var uncertainAttempts: Int?

    public init(
        eventID: String,
        payloadJSON: String,
        senderPublicKey: String,
        receivedAt: Date = Date(),
        uncertainAttempts: Int? = nil
    ) {
        self.eventID = eventID.lowercased()
        self.payloadJSON = payloadJSON
        self.senderPublicKey = senderPublicKey.lowercased()
        self.receivedAt = receivedAt
        self.uncertainAttempts = uncertainAttempts
    }
}

public struct CashuPaymentRequestReceipt: Equatable, Sendable {
    public let eventID: String
    public let requestID: String
    public let mintURL: String
    public let amount: UInt64
    public let memo: String?
    public let senderPublicKey: String

    public init(
        eventID: String,
        requestID: String,
        mintURL: String,
        amount: UInt64,
        memo: String?,
        senderPublicKey: String
    ) {
        self.eventID = eventID
        self.requestID = requestID
        self.mintURL = mintURL
        self.amount = amount
        self.memo = memo
        self.senderPublicKey = senderPublicKey
    }
}

public enum CashuPaymentRequestContract {
    public static func createNostrRequest(
        amount: UInt64?,
        description: String?,
        mintURLs: [String],
        recipientPublicKey: String,
        relayURLs: [String],
        singleUse: Bool,
        requestID: String = Self.randomRequestID(),
        createdAt: Date = Date()
    ) throws -> CashuCreatedPaymentRequest {
        if let amount, amount == 0 { throw CashuWalletError.paymentRequestAmountRequired }
        guard let publicKey = try? Data(hex: recipientPublicKey), publicKey.count == 32 else {
            throw CashuWalletError.paymentRequestIdentityUnavailable
        }

        let normalizedRelays = TaskifyRelayURL.normalizedList(relayURLs)
        guard !normalizedRelays.isEmpty else {
            throw CashuWalletError.paymentRequestRelayUnavailable
        }
        let normalizedMints = try uniqueMintURLs(mintURLs)
        guard !normalizedMints.isEmpty else {
            throw CashuWalletError.paymentRequestMintUnavailable
        }
        let normalizedID = requestID
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard !normalizedID.isEmpty, normalizedID.utf8.count <= 64 else {
            throw CashuWalletError.invalidPaymentRequest
        }

        let memo = description?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .prefix(280)
        let normalizedDescription = memo.flatMap { $0.isEmpty ? nil : String($0) }
        let nprofile = try nprofile(publicKey: publicKey, relayURLs: normalizedRelays)

        var fields: [(String, CBORValue)] = [
            ("i", .text(normalizedID)),
            ("u", .text("sat")),
            ("s", .boolean(singleUse)),
            ("m", .array(normalizedMints.map(CBORValue.text))),
            ("t", .array([
                .map([
                    ("t", .text("nostr")),
                    ("a", .text(nprofile)),
                    ("g", .array([.array([.text("n"), .text("17")])]))
                ])
            ]))
        ]
        if let amount { fields.append(("a", .unsigned(amount))) }
        if let normalizedDescription { fields.append(("d", .text(normalizedDescription))) }

        let encodedA = "creqA" + CBORWriter.encode(.map(fields)).base64URLEncodedString()
        let request = try PaymentRequest.fromString(encoded: encodedA)
        let compact = try request.toBech32String().uppercased()

        return CashuCreatedPaymentRequest(
            requestID: normalizedID,
            encoded: compact,
            amount: amount,
            description: normalizedDescription,
            mintURLs: normalizedMints,
            relayURLs: normalizedRelays,
            singleUse: singleUse,
            createdAt: createdAt
        )
    }

    public static func paymentPayloadJSON(from content: String) -> String? {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let data = trimmed.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any],
              let requestID = dictionary["id"] as? String,
              !requestID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let mint = dictionary["mint"] as? String,
              !mint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let unit = dictionary["unit"] as? String,
              unit.lowercased() == "sat",
              let proofs = dictionary["proofs"] as? [[String: Any]],
              !proofs.isEmpty,
              (try? PaymentRequestPayload.fromString(json: trimmed)) != nil else {
            return nil
        }
        return trimmed
    }

    private static let tokenTextExpression = try! NSRegularExpression(
        pattern: #"cashu[A-Za-z0-9_+/=-]{10,}"#,
        options: [.caseInsensitive]
    )

    /// Finds a Cashu token embedded in free text, matching the PWA's `extractFirstCashuTokenFromText`
    /// fallback for tokens sent as plain chat text rather than through the formal NUT-18
    /// payment-request/response flow. Used only to decide whether to offer a redeem card in chat —
    /// the token itself is still verified end to end by the normal receive flow before any balance
    /// changes.
    public static func firstTokenSubstring(in text: String) -> String? {
        guard text.range(of: "cashu", options: .caseInsensitive) != nil else { return nil }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = tokenTextExpression.firstMatch(in: text, range: range),
              let matchRange = Range(match.range, in: text) else { return nil }
        var candidate = String(text[matchRange])
        while let last = candidate.last, ".,!?;:'\"”’)]}>".contains(last) {
            candidate.removeLast()
        }
        return candidate.isEmpty ? nil : candidate
    }

    /// Reconstruct the complete NUT-00 token carried by a NUT-18 payment
    /// payload. CDK's reference receiver feeds this token through the normal
    /// wallet receive API so inactive keysets, DLEQ data, transaction storage,
    /// and receive-saga recovery all follow the same path as a scanned token.
    public static func tokenString(fromPaymentPayload content: String) throws -> String {
        guard let payload = paymentPayloadJSON(from: content),
              let data = payload.data(using: .utf8),
              let dictionary = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let mint = dictionary["mint"] as? String,
              let proofs = dictionary["proofs"] as? [[String: Any]],
              !proofs.isEmpty,
              let token = tokenString(
                mint: mint,
                proofs: proofs,
                unit: dictionary["unit"] as? String,
                memo: dictionary["memo"] as? String
              ) else {
            throw CashuWalletError.invalidPaymentRequest
        }
        return token
    }

    /// Extracts a redeemable token from arbitrary incoming DM content: a raw token string, or a
    /// bare `{mint, proofs}` JSON shape reconstructed the same way as a NUT-18 payload but
    /// *without* requiring the "id"/full envelope that only makes sense for a payment request
    /// this device created. A Lightning-address forwarder (e.g. solife.me) has no such request —
    /// it just drops mint+proofs (or an encoded token) in a DM whenever someone pays the address.
    /// Matches the PWA's tolerant `selectIncomingPaymentFromPayload`, which treats any decodable
    /// incoming payment as receivable regardless of whether it fulfills a known request.
    public static func extractReceivableToken(from content: String) -> String? {
        if let token = firstTokenSubstring(in: content) {
            return token
        }
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let data = trimmed.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any],
              let mint = dictionary["mint"] as? String,
              !mint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let proofs = dictionary["proofs"] as? [[String: Any]],
              !proofs.isEmpty else {
            return nil
        }
        return tokenString(
            mint: mint,
            proofs: proofs,
            unit: dictionary["unit"] as? String,
            memo: dictionary["memo"] as? String
        )
    }

    private static func tokenString(
        mint: String,
        proofs: [[String: Any]],
        unit: String?,
        memo: String?
    ) -> String? {
        var token: [String: Any] = ["token": [["mint": mint, "proofs": proofs]]]
        if let unit { token["unit"] = unit }
        if let memo { token["memo"] = memo }
        guard JSONSerialization.isValidJSONObject(token),
              let tokenData = try? JSONSerialization.data(
                withJSONObject: token,
                options: [.sortedKeys]
              ) else {
            return nil
        }
        let encoded = tokenData.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return "cashuA" + encoded
    }

    /// Rebuilds a portable token from the proofs CDK associated with an
    /// outgoing transaction. CDK's payment-request API intentionally returns
    /// no token, even though it creates one internally, so retaining payment
    /// history requires reconstructing the same bearer ecash immediately
    /// after the send is confirmed.
    public static func tokenString(
        mintURL: String,
        unit: String = "sat",
        memo: String? = nil,
        proofs: [Proof]
    ) throws -> String {
        guard !mintURL.isEmpty, !proofs.isEmpty else {
            throw CashuWalletError.invalidPaymentRequest
        }

        let encodedProofs: [[String: Any]] = try proofs.map { proof in
            var encoded: [String: Any] = [
                "amount": proof.amount.value,
                // cashuA uses the 8-byte short keyset identifier. For v2
                // keysets this is the version byte plus the first 7 ID bytes.
                "id": String(proof.keysetId.prefix(16)),
                "secret": proof.secret,
                "C": proof.c,
            ]
            if let dleq = proof.dleq {
                encoded["dleq"] = ["e": dleq.e, "s": dleq.s, "r": dleq.r]
            }
            if let witness = proof.witness {
                let witnessObject: [String: Any]
                switch witness {
                case .p2pk(let signatures):
                    witnessObject = ["signatures": signatures]
                case .htlc(let preimage, let signatures):
                    var htlc: [String: Any] = ["preimage": preimage]
                    if let signatures { htlc["signatures"] = signatures }
                    witnessObject = htlc
                }
                let data = try JSONSerialization.data(
                    withJSONObject: witnessObject,
                    options: [.sortedKeys]
                )
                guard let value = String(data: data, encoding: .utf8) else {
                    throw CashuWalletError.invalidPaymentRequest
                }
                encoded["witness"] = value
            }
            return encoded
        }

        var token: [String: Any] = [
            "token": [["mint": mintURL, "proofs": encodedProofs]],
            "unit": unit,
        ]
        if let memo, !memo.isEmpty { token["memo"] = memo }
        guard JSONSerialization.isValidJSONObject(token) else {
            throw CashuWalletError.invalidPaymentRequest
        }
        let tokenData = try JSONSerialization.data(withJSONObject: token, options: [.sortedKeys])
        let encoded = tokenData.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let value = "cashuA" + encoded
        _ = try Token.decode(encodedToken: value)
        return value
    }

    public static func randomRequestID() -> String {
        var generator = SystemRandomNumberGenerator()
        return (0..<8)
            .map { _ in String(format: "%02x", UInt8.random(in: .min ... .max, using: &generator)) }
            .joined()
    }

    private static func uniqueMintURLs(_ values: [String]) throws -> [String] {
        var seen = Set<String>()
        return try values.compactMap { value in
            let normalized = try CashuWalletService.normalizedMintURL(value)
            return seen.insert(normalized).inserted ? normalized : nil
        }
    }

    private static func nprofile(publicKey: Data, relayURLs: [String]) throws -> String {
        var payload = Data([0, UInt8(publicKey.count)])
        payload.append(publicKey)
        for relay in relayURLs {
            let bytes = Data(relay.utf8)
            guard bytes.count <= Int(UInt8.max) else { continue }
            payload.append(1)
            payload.append(UInt8(bytes.count))
            payload.append(bytes)
        }
        return try Bech32.encode(prefix: "nprofile", data: payload)
    }
}

/// An unsolicited incoming Cashu token found in a plain DM — distinct from
/// `CashuNostrPaymentDelivery`, which only ever fulfills a payment request this device created.
/// A Lightning-address forwarder (e.g. solife.me) has no such request to match against: it just
/// drops a token in your DMs whenever someone pays your address. Matches the PWA's
/// `processIncomingPaymentPayload`, which auto-claims any decodable incoming token regardless of
/// whether it corresponds to a request the user made.
public struct CashuIncomingTokenDelivery: Identifiable, Codable, Equatable, Sendable {
    public var id: String { eventID }
    public let eventID: String
    public let token: String
    public let senderPublicKey: String
    public let receivedAt: Date

    public init(
        eventID: String,
        token: String,
        senderPublicKey: String,
        receivedAt: Date = Date()
    ) {
        self.eventID = eventID.lowercased()
        self.token = token
        self.senderPublicKey = senderPublicKey.lowercased()
        self.receivedAt = receivedAt
    }
}

public enum CashuIncomingTokenInboxStore {
    private static let maximumAge: TimeInterval = 30 * 24 * 60 * 60
    /// The NIP-17 subscription replays up to 30 days of history. Keep handled identifiers one day
    /// longer so a delivery completed or rejected near the boundary cannot be re-enqueued by a
    /// later relay during that replay window.
    private static let handledMaximumAge: TimeInterval = 31 * 24 * 60 * 60
    private static let maximumCount = 200
    private static let maximumHandledCount = 1_000

    private struct HandledDelivery: Codable, Equatable {
        var eventID: String
        var tokenFingerprint: String
        var handledAt: Date
    }

    public static func defaultURL() throws -> URL {
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
        return directory.appendingPathComponent("incoming-token-inbox.json")
    }

    @discardableResult
    public static func enqueue(
        _ delivery: CashuIncomingTokenDelivery,
        at url: URL,
        now: Date = Date()
    ) throws -> Bool {
        var deliveries = load(from: url, now: now)
        let fingerprint = tokenFingerprint(delivery.token)
        let handled = handledDeliveries(at: url, now: now)
        guard !handled.contains(where: {
            $0.eventID == delivery.eventID || $0.tokenFingerprint == fingerprint
        }),
        !deliveries.contains(where: {
            $0.eventID == delivery.eventID || tokenFingerprint($0.token) == fingerprint
        }) else { return false }
        deliveries.append(delivery)
        deliveries = Array(deliveries.sorted { $0.receivedAt < $1.receivedAt }.suffix(maximumCount))
        try save(deliveries, to: url)
        return true
    }

    public static func load(from url: URL, now: Date = Date()) -> [CashuIncomingTokenDelivery] {
        guard let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode([CashuIncomingTokenDelivery].self, from: data) else {
            return []
        }
        let handled = handledDeliveries(at: url, now: now)
        let handledEventIDs = Set(handled.map(\.eventID))
        let handledFingerprints = Set(handled.map(\.tokenFingerprint))
        return decoded.filter {
            now.timeIntervalSince($0.receivedAt) <= maximumAge
                && !handledEventIDs.contains($0.eventID)
                && !handledFingerprints.contains(tokenFingerprint($0.token))
        }
    }

    public static func remove(eventIDs: Set<String>, at url: URL, now: Date = Date()) throws {
        let remaining = load(from: url, now: now).filter { !eventIDs.contains($0.eventID) }
        try save(remaining, to: url)
    }

    /// Atomically establishes replay suppression before removing the pending delivery. If the app
    /// is interrupted between those writes, `load` still filters the pending copy using this
    /// ledger, and relay replay cannot enqueue either the same wrap or the same token again.
    public static func markHandled(
        _ delivery: CashuIncomingTokenDelivery,
        at url: URL,
        now: Date = Date()
    ) throws {
        let fingerprint = tokenFingerprint(delivery.token)
        var handled = handledDeliveries(at: url, now: now)
        if let index = handled.firstIndex(where: {
            $0.eventID == delivery.eventID || $0.tokenFingerprint == fingerprint
        }) {
            handled[index] = HandledDelivery(
                eventID: delivery.eventID,
                tokenFingerprint: fingerprint,
                handledAt: now
            )
        } else {
            handled.append(HandledDelivery(
                eventID: delivery.eventID,
                tokenFingerprint: fingerprint,
                handledAt: now
            ))
        }
        handled = Array(handled.sorted { $0.handledAt < $1.handledAt }.suffix(maximumHandledCount))
        try saveHandled(handled, at: url)
        try remove(eventIDs: [delivery.eventID], at: url, now: now)
    }

    private static func save(_ deliveries: [CashuIncomingTokenDelivery], to url: URL) throws {
        let data = try JSONEncoder().encode(deliveries)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUnlessOpen])
    }

    private static func handledDeliveries(
        at inboxURL: URL,
        now: Date
    ) -> [HandledDelivery] {
        let url = handledURL(for: inboxURL)
        guard let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode([HandledDelivery].self, from: data) else {
            return []
        }
        return decoded.filter { now.timeIntervalSince($0.handledAt) <= handledMaximumAge }
    }

    private static func saveHandled(
        _ deliveries: [HandledDelivery],
        at inboxURL: URL
    ) throws {
        let data = try JSONEncoder().encode(deliveries)
        try data.write(
            to: handledURL(for: inboxURL),
            options: [.atomic, .completeFileProtectionUnlessOpen]
        )
    }

    private static func handledURL(for inboxURL: URL) -> URL {
        inboxURL
            .deletingPathExtension()
            .appendingPathExtension("handled.json")
    }

    private static func tokenFingerprint(_ token: String) -> String {
        CashuWalletService.pendingReceiveFingerprint(token)
    }
}

public enum CashuNostrPaymentInboxStore {
    private static let maximumAge: TimeInterval = 30 * 24 * 60 * 60
    private static let maximumCount = 200

    public static func defaultURL() throws -> URL {
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
        return directory.appendingPathComponent("nostr-payment-inbox.json")
    }

    @discardableResult
    public static func enqueue(
        _ delivery: CashuNostrPaymentDelivery,
        at url: URL,
        now: Date = Date()
    ) throws -> Bool {
        var deliveries = load(from: url, now: now)
        guard !deliveries.contains(where: { $0.eventID == delivery.eventID }) else { return false }
        deliveries.append(delivery)
        deliveries = Array(deliveries.sorted { $0.receivedAt < $1.receivedAt }.suffix(maximumCount))
        try save(deliveries, to: url)
        return true
    }

    public static func load(from url: URL, now: Date = Date()) -> [CashuNostrPaymentDelivery] {
        guard let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode([CashuNostrPaymentDelivery].self, from: data) else {
            return []
        }
        return decoded.filter { now.timeIntervalSince($0.receivedAt) <= maximumAge }
    }

    public static func remove(eventIDs: Set<String>, at url: URL, now: Date = Date()) throws {
        let remaining = load(from: url, now: now).filter { !eventIDs.contains($0.eventID) }
        try save(remaining, to: url)
    }

    /// Replaces an existing delivery in place (matched by `eventID`) — used to persist an
    /// incremented `uncertainAttempts` without disturbing the rest of the queue.
    public static func update(_ delivery: CashuNostrPaymentDelivery, at url: URL, now: Date = Date()) throws {
        var deliveries = load(from: url, now: now)
        guard let index = deliveries.firstIndex(where: { $0.eventID == delivery.eventID }) else { return }
        deliveries[index] = delivery
        try save(deliveries, to: url)
    }

    private static func save(_ deliveries: [CashuNostrPaymentDelivery], to url: URL) throws {
        let data = try JSONEncoder().encode(deliveries)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUnlessOpen])
    }
}

private enum CBORValue {
    case unsigned(UInt64)
    case text(String)
    case boolean(Bool)
    case array([CBORValue])
    case map([(String, CBORValue)])
}

private enum CBORWriter {
    static func encode(_ value: CBORValue) -> Data {
        var data = Data()
        append(value, to: &data)
        return data
    }

    private static func append(_ value: CBORValue, to data: inout Data) {
        switch value {
        case .unsigned(let value):
            appendHeader(major: 0, value: value, to: &data)
        case .text(let value):
            let bytes = Data(value.utf8)
            appendHeader(major: 3, value: UInt64(bytes.count), to: &data)
            data.append(bytes)
        case .boolean(let value):
            data.append(value ? 0xf5 : 0xf4)
        case .array(let values):
            appendHeader(major: 4, value: UInt64(values.count), to: &data)
            for value in values { append(value, to: &data) }
        case .map(let values):
            appendHeader(major: 5, value: UInt64(values.count), to: &data)
            for (key, value) in values {
                append(.text(key), to: &data)
                append(value, to: &data)
            }
        }
    }

    private static func appendHeader(major: UInt8, value: UInt64, to data: inout Data) {
        let prefix = major << 5
        switch value {
        case 0..<24:
            data.append(prefix | UInt8(value))
        case 24...UInt64(UInt8.max):
            data.append(prefix | 24)
            data.append(UInt8(value))
        case 256...UInt64(UInt16.max):
            data.append(prefix | 25)
            appendBigEndian(UInt16(value), to: &data)
        case 65_536...UInt64(UInt32.max):
            data.append(prefix | 26)
            appendBigEndian(UInt32(value), to: &data)
        default:
            data.append(prefix | 27)
            appendBigEndian(value, to: &data)
        }
    }

    private static func appendBigEndian<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
        var bigEndian = value.bigEndian
        withUnsafeBytes(of: &bigEndian) { data.append(contentsOf: $0) }
    }
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
    }
}
