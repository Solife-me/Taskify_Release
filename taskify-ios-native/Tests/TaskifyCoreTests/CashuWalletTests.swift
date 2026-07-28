import Cdk
import XCTest
@testable import TaskifyCore

final class CashuWalletTests: XCTestCase {
    func testMintURLNormalizationRequiresSecureCompleteURL() throws {
        XCTAssertEqual(
            try CashuWalletService.normalizedMintURL("  https://mint.solife.me///  "),
            "https://mint.solife.me"
        )
        XCTAssertThrowsError(try CashuWalletService.normalizedMintURL("mint.solife.me"))
        XCTAssertThrowsError(try CashuWalletService.normalizedMintURL("http://mint.solife.me"))
        XCTAssertEqual(
            try CashuWalletService.normalizedMintURL("http://localhost:3338/"),
            "http://localhost:3338"
        )
    }

    func testMintTransferValidationRequiresDistinctMintsAmountAndBalance() throws {
        let validated = try CashuWalletService.validateMintTransfer(
            amount: 500,
            sourceMintURL: "https://one.example/",
            destinationMintURL: "https://two.example",
            available: 550
        )
        XCTAssertEqual(validated.source, "https://one.example")
        XCTAssertEqual(validated.destination, "https://two.example")

        XCTAssertThrowsError(try CashuWalletService.validateMintTransfer(
            amount: 0,
            sourceMintURL: "https://one.example",
            destinationMintURL: "https://two.example",
            available: 550
        )) { error in
            XCTAssertEqual(error as? CashuWalletError, .invalidLightningAmount)
        }

        XCTAssertThrowsError(try CashuWalletService.validateMintTransfer(
            amount: 500,
            sourceMintURL: "https://one.example/",
            destinationMintURL: "https://one.example",
            available: 550
        )) { error in
            XCTAssertEqual(error as? CashuWalletError, .mintTransferSameMint)
        }

        XCTAssertThrowsError(try CashuWalletService.validateMintTransfer(
            amount: 551,
            sourceMintURL: "https://one.example",
            destinationMintURL: "https://two.example",
            available: 550
        )) { error in
            XCTAssertEqual(error as? CashuWalletError, .mintTransferInsufficientBalance)
        }
    }

    func testMintTransferResultDistinguishesPendingFromCompleted() {
        let pending = CashuMintTransferResult(
            sourceMintURL: "https://one.example",
            destinationMintURL: "https://two.example",
            amount: 100,
            receivedAmount: 0,
            feePaid: nil,
            receiveQuoteID: "receive-1",
            paymentQuoteID: "payment-1",
            state: .pending
        )
        let completed = CashuMintTransferResult(
            sourceMintURL: pending.sourceMintURL,
            destinationMintURL: pending.destinationMintURL,
            amount: pending.amount,
            receivedAmount: 100,
            feePaid: 2,
            receiveQuoteID: pending.receiveQuoteID,
            paymentQuoteID: pending.paymentQuoteID,
            state: .completed
        )

        XCTAssertEqual(pending.state, .pending)
        XCTAssertEqual(completed.state, .completed)
        XCTAssertEqual(completed.feePaid, 2)
    }

    func testPendingReceiveFingerprintIsStableAcrossClipboardWhitespace() {
        let compact = CashuWalletService.pendingReceiveFingerprint("cashuBexample")
        let pasted = CashuWalletService.pendingReceiveFingerprint("  cashuBexample\n")

        XCTAssertEqual(compact, pasted)
        XCTAssertEqual(compact.count, 64)
        XCTAssertNotEqual(
            compact,
            CashuWalletService.pendingReceiveFingerprint("cashuBdifferent")
        )
    }

    func testPendingReceiveJournalRoundTripsAndDeduplicatesBearerTokens() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskify-pending-receives-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("pending.json")
        let older = CashuPendingReceive(
            id: "same-token",
            token: "cashuBtoken",
            mintURL: "https://mint.example",
            amount: 21,
            memo: "Coffee",
            createdAt: Date(timeIntervalSince1970: 1_000),
            attemptCount: 1,
            lastAttemptAt: Date(timeIntervalSince1970: 1_010),
            lastError: "offline"
        )
        let newer = CashuPendingReceive(
            id: older.id,
            token: older.token,
            mintURL: older.mintURL,
            amount: older.amount,
            memo: older.memo,
            createdAt: Date(timeIntervalSince1970: 2_000),
            state: .needsAttention,
            attemptCount: 2,
            lastAttemptAt: Date(timeIntervalSince1970: 2_010),
            lastError: "already spent"
        )
        try JSONEncoder().encode([older, newer]).write(to: url, options: .atomic)

        let loaded = CashuWalletService.loadPendingReceives(from: url)

        XCTAssertEqual(loaded, [newer])
        XCTAssertFalse(loaded[0].isRecoverable)
    }

    func testAlreadySpentReceiveErrorsBecomeAttentionItems() {
        XCTAssertTrue(CashuWalletService.isTokenAlreadySpentMessage("Proof already spent"))
        XCTAssertTrue(CashuWalletService.isTokenAlreadySpentMessage("inputs have already been spent"))
        XCTAssertTrue(CashuWalletService.isTokenAlreadySpentMessage("Duplicate inputs"))
        XCTAssertFalse(CashuWalletService.isTokenAlreadySpentMessage("network request timed out"))
    }

    func testWalletSnapshotTotalsAvailablePendingAndReservedBalances() {
        let snapshot = CashuWalletSnapshot(
            mints: [
                CashuMintSummary(
                    url: "https://one.example",
                    name: "One",
                    available: 21,
                    pending: 2,
                    reserved: 3,
                    isReachable: true
                ),
                CashuMintSummary(
                    url: "https://two.example",
                    name: "Two",
                    available: 34,
                    pending: 5,
                    reserved: 8,
                    isReachable: false
                ),
            ],
            transactions: [],
            outgoingTokens: []
        )

        XCTAssertEqual(snapshot.available, 55)
        XCTAssertEqual(snapshot.pending, 7)
        XCTAssertEqual(snapshot.reserved, 11)
    }

    func testSeedTransferSummaryReportsReceiveFeeWithoutUnderflow() {
        let charged = CashuMintTransferSummary(
            mintURL: "https://mint.example",
            recovered: 1_000,
            deposited: 997,
            pending: 0
        )
        let unchanged = CashuMintTransferSummary(
            mintURL: "https://mint.example",
            recovered: 1_000,
            deposited: 1_000,
            pending: 0
        )
        let defensive = CashuMintTransferSummary(
            mintURL: "https://mint.example",
            recovered: 1_000,
            deposited: 1_001,
            pending: 0
        )

        XCTAssertEqual(charged.fee, 3)
        XCTAssertEqual(unchanged.fee, 0)
        XCTAssertEqual(defensive.fee, 0)
    }

    func testLightningReceiveQuoteRoundTripsAndExpiresOnlyWhileUnpaid() throws {
        let expiry = Date(timeIntervalSince1970: 2_000)
        let unpaid = CashuLightningReceiveQuote(
            id: "quote-1",
            mintURL: "https://mint.example",
            amount: 2_100,
            invoice: "lnbc21u1example",
            createdAt: Date(timeIntervalSince1970: 1_000),
            expiresAt: expiry,
            state: .unpaid,
            issuedAmount: 0
        )
        var paid = unpaid
        paid.state = .paid

        let decoded = try JSONDecoder().decode(
            CashuLightningReceiveQuote.self,
            from: JSONEncoder().encode(unpaid)
        )

        XCTAssertEqual(decoded, unpaid)
        XCTAssertFalse(unpaid.isExpired(at: Date(timeIntervalSince1970: 1_999)))
        XCTAssertTrue(unpaid.isExpired(at: Date(timeIntervalSince1970: 2_000)))
        XCTAssertFalse(paid.isExpired(at: Date(timeIntervalSince1970: 3_000)))
        XCTAssertTrue(unpaid.isOutstanding(at: Date(timeIntervalSince1970: 1_999)))
        XCTAssertFalse(unpaid.isOutstanding(at: Date(timeIntervalSince1970: 2_000)))
        XCTAssertTrue(paid.isOutstanding(at: Date(timeIntervalSince1970: 3_000)))

        var issued = paid
        issued.state = .issued
        XCTAssertFalse(issued.isOutstanding(at: Date(timeIntervalSince1970: 3_000)))
    }

    func testLightningReceiveRejectsZeroBeforeContactingMint() async throws {
        let mnemonic = try CashuWalletService.generateMnemonic()
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskify-lightning-quote-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let service = try CashuWalletService(
            databaseURL: directory.appendingPathComponent("wallet.sqlite"),
            outgoingTokensURL: directory.appendingPathComponent("outgoing.json"),
            mnemonic: mnemonic
        )

        do {
            _ = try await service.createLightningReceiveQuote(
                mintURL: "https://mint.example",
                amount: 0
            )
            XCTFail("Expected zero-amount Lightning quote creation to fail")
        } catch {
            XCTAssertEqual(error as? CashuWalletError, .invalidLightningAmount)
        }
    }

    func testLightningInvoiceNormalizationAcceptsBolt11AndLightningURI() throws {
        XCTAssertEqual(
            try CashuWalletService.normalizedLightningInvoice("  lnbc21u1example  "),
            "lnbc21u1example"
        )
        XCTAssertEqual(
            try CashuWalletService.normalizedLightningInvoice("LIGHTNING:LNBC21U1EXAMPLE"),
            "LNBC21U1EXAMPLE"
        )
        XCTAssertEqual(
            try CashuWalletService.normalizedLightningInvoice("lntb10u1testnet"),
            "lntb10u1testnet"
        )
        XCTAssertThrowsError(try CashuWalletService.normalizedLightningInvoice("cashuAeyJ0b2tlbiI6W119fQ"))
        XCTAssertThrowsError(try CashuWalletService.normalizedLightningInvoice("https://example.com/invoice"))
        XCTAssertThrowsError(try CashuWalletService.normalizedLightningInvoice(""))
    }

    func testLightningPaymentQuoteCalculatesMaximumAndExpiry() {
        let expiry = Date(timeIntervalSince1970: 5_000)
        let quote = CashuLightningPaymentQuote(
            id: UUID(),
            quoteID: "melt-quote",
            mintURL: "https://mint.example",
            invoice: "lnbc21u1example",
            amount: 2_100,
            feeReserve: 21,
            walletFee: 2,
            expiresAt: expiry
        )

        XCTAssertEqual(quote.maximumTotal, 2_123)
        XCTAssertFalse(quote.isExpired(at: Date(timeIntervalSince1970: 4_999)))
        XCTAssertTrue(quote.isExpired(at: expiry))
    }

    func testPaymentRequestPreviewDecodesNut18RequestDetails() throws {
        let encoded = "creqApWF0gaNhdGVub3N0cmFheKlucHJvZmlsZTFxeTI4d3VtbjhnaGo3dW45ZDNzaGp0bnl2OWtoMnVld2Q5aHN6OW1od2RlbjV0ZTB3ZmprY2N0ZTljdXJ4dmVuOWVlaHFjdHJ2NWhzenJ0aHdkZW41dGUwZGVoaHh0bnZkYWtxcWd5ZGFxeTdjdXJrNDM5eWtwdGt5c3Y3dWRoZGh1NjhzdWNtMjk1YWtxZWZkZWhrZjBkNDk1Y3d1bmw1YWeBgmFuYjE3YWloYjdhOTAxNzZhYQphdWNzYXRhbYF4Imh0dHBzOi8vbm9mZWVzLnRlc3RudXQuY2FzaHUuc3BhY2U="

        let preview = try CashuWalletService.previewPaymentRequest(encoded)

        XCTAssertEqual(preview.encoded, encoded)
        XCTAssertEqual(preview.paymentID, "b7a90176")
        XCTAssertEqual(preview.amount, 10)
        XCTAssertEqual(preview.mintURLs, ["https://nofees.testnut.cashu.space"])
        XCTAssertEqual(preview.transports, [.nostr])
    }

    func testPaymentRequestPreviewExtractsNut26FromBip321() throws {
        let encoded = "CREQB1QYQQWER9D4HNZV3NQGQQSQQQQQQQQQQRAQPSQQGQQSQQZQG9QQVXSAR5WPEN5TE0D45KUAPWV4UXZMTSD3JJUCM0D5RQQRJRDANXVET9YPCXZ7TDV4H8GXHR3TQ"
        let uri = "bitcoin:?lightning=lnbc100n1example&creq=\(encoded)"

        let preview = try CashuWalletService.previewPaymentRequest(uri)

        XCTAssertEqual(preview.encoded, encoded)
        XCTAssertEqual(preview.paymentID, "demo123")
        XCTAssertEqual(preview.amount, 1_000)
        XCTAssertEqual(preview.description, "Coffee payment")
        XCTAssertEqual(preview.mintURLs, ["https://mint.example.com"])
        XCTAssertEqual(preview.singleUse, true)
        XCTAssertTrue(preview.transports.isEmpty)
    }

    func testPaymentRequestMintCompatibilityNormalizesURLs() throws {
        let preview = CashuPaymentRequestPreview(
            encoded: "creqAexample",
            paymentID: nil,
            amount: nil,
            description: nil,
            mintURLs: ["https://mint.example/"],
            singleUse: false,
            transports: [.httpPost]
        )
        let openRequest = CashuPaymentRequestPreview(
            encoded: preview.encoded,
            paymentID: nil,
            amount: nil,
            description: nil,
            mintURLs: [],
            singleUse: false,
            transports: [.nostr]
        )

        XCTAssertTrue(CashuWalletService.paymentRequestAcceptsMint(
            preview,
            mintURL: "https://mint.example"
        ))
        XCTAssertFalse(CashuWalletService.paymentRequestAcceptsMint(
            preview,
            mintURL: "https://other.example"
        ))
        XCTAssertTrue(CashuWalletService.paymentRequestAcceptsMint(
            openRequest,
            mintURL: "https://other.example"
        ))
    }

    func testNativeNostrPaymentRequestRoundTripsThroughCurrentCDK() throws {
        let request = try CashuPaymentRequestContract.createNostrRequest(
            amount: 2_100,
            description: "Native coffee",
            mintURLs: ["https://mint.example/"],
            recipientPublicKey: String(repeating: "11", count: 32),
            relayURLs: ["wss://relay.example/", "wss://relay.example"],
            singleUse: true,
            requestID: "native-request",
            createdAt: Date(timeIntervalSince1970: 1_000)
        )
        let preview = try CashuWalletService.previewPaymentRequest(request.encoded)

        XCTAssertTrue(request.encoded.hasPrefix("CREQB1"))
        XCTAssertEqual(request.requestID, "native-request")
        XCTAssertEqual(request.mintURLs, ["https://mint.example"])
        XCTAssertEqual(request.relayURLs, ["wss://relay.example"])
        XCTAssertEqual(preview.paymentID, "native-request")
        XCTAssertEqual(preview.amount, 2_100)
        XCTAssertEqual(preview.description, "Native coffee")
        XCTAssertEqual(preview.mintURLs, ["https://mint.example"])
        XCTAssertEqual(preview.singleUse, true)
        XCTAssertEqual(preview.transports, [.nostr])
    }

    func testNostrPaymentPayloadDetectionRejectsOrdinaryChat() {
        let payload = """
        {
          "id":"native-request",
          "memo":"Coffee",
          "mint":"https://mint.example",
          "unit":"sat",
          "proofs":[{
            "amount":1,
            "secret":"test-secret",
            "C":"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
            "id":"009a1f293253e41e"
          }]
        }
        """

        XCTAssertEqual(
            CashuPaymentRequestContract.paymentPayloadJSON(from: payload),
            payload
        )
        XCTAssertNil(CashuPaymentRequestContract.paymentPayloadJSON(from: "Hello from chat"))
        XCTAssertNil(CashuPaymentRequestContract.paymentPayloadJSON(from: "{\"id\":\"native-request\"}"))
    }

    func testNostrPaymentPayloadReconstructsCompleteTokenForCDKReceive() async throws {
        let payload = """
        {
          "id":"native-request",
          "memo":"Coffee",
          "mint":"https://mint.example",
          "unit":"sat",
          "proofs":[{
            "amount":1,
            "secret":"test-secret",
            "C":"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
            "id":"009a1f293253e41e"
          }]
        }
        """
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskify-request-token-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let service = try CashuWalletService(
            databaseURL: directory.appendingPathComponent("wallet.sqlite"),
            outgoingTokensURL: directory.appendingPathComponent("outgoing.json"),
            mnemonic: CashuWalletService.generateMnemonic()
        )

        let token = try CashuPaymentRequestContract.tokenString(fromPaymentPayload: payload)
        let preview = try await service.previewToken(token)

        XCTAssertTrue(token.hasPrefix("cashuA"))
        XCTAssertEqual(preview.mintURL, "https://mint.example")
        XCTAssertEqual(preview.amount, 1)
        XCTAssertEqual(preview.memo, "Coffee")
    }

    func testFirstTokenSubstringExtractsCashuTokenEmbeddedInChatText() {
        XCTAssertEqual(
            CashuPaymentRequestContract.firstTokenSubstring(
                in: "Here you go: cashuAeyJ0b2tlbiI6W119fQ, enjoy!"
            ),
            "cashuAeyJ0b2tlbiI6W119fQ"
        )
        XCTAssertNil(CashuPaymentRequestContract.firstTokenSubstring(in: "Thanks for lunch!"))
        XCTAssertNil(CashuPaymentRequestContract.firstTokenSubstring(in: "just the word cashu, no token"))
    }

    func testOfflineTokenSummaryDecodesAmountMintAndMemoWithoutNetwork() throws {
        let proof = Proof(
            amount: Amount(value: 21),
            secret: "offline-summary-secret",
            c: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
            keysetId: "009a1f293253e41e",
            witness: nil,
            dleq: nil,
            p2pkE: nil
        )
        let token = try CashuPaymentRequestContract.tokenString(
            mintURL: "https://mint.example",
            memo: "Chat payment",
            proofs: [proof]
        )

        let summary = try XCTUnwrap(CashuWalletService.offlineTokenSummary(token))

        XCTAssertEqual(summary.amount, 21)
        XCTAssertEqual(summary.mintURL, "https://mint.example")
        XCTAssertEqual(summary.memo, "Chat payment")
        XCTAssertNil(CashuWalletService.offlineTokenSummary("not a token"))
    }

    func testOutgoingTransactionProofsReconstructCompleteHistoryToken() async throws {
        let proof = Proof(
            amount: Amount(value: 21),
            secret: "history-token-secret",
            c: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
            keysetId: "009a1f293253e41e",
            witness: nil,
            dleq: nil,
            p2pkE: nil
        )
        let token = try CashuPaymentRequestContract.tokenString(
            mintURL: "https://mint.example",
            memo: "Saved payment",
            proofs: [proof]
        )
        let decoded = try Token.decode(encodedToken: token)

        XCTAssertTrue(token.hasPrefix("cashuA"))
        XCTAssertEqual(try decoded.value().value, 21)
        XCTAssertEqual(decoded.memo(), "Saved payment")
        XCTAssertEqual(try decoded.proofsSimple().first?.secret, "history-token-secret")
    }

    func testNostrPaymentInboxIsDurableDeduplicatedAndExpiresOldDeliveries() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskify-payment-inbox-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("inbox.json")
        let now = Date(timeIntervalSince1970: 4_000_000)
        let current = CashuNostrPaymentDelivery(
            eventID: String(repeating: "a", count: 64),
            payloadJSON: "{}",
            senderPublicKey: String(repeating: "b", count: 64),
            receivedAt: now.addingTimeInterval(-60)
        )
        let expired = CashuNostrPaymentDelivery(
            eventID: String(repeating: "c", count: 64),
            payloadJSON: "{}",
            senderPublicKey: String(repeating: "d", count: 64),
            receivedAt: now.addingTimeInterval(-(31 * 24 * 60 * 60))
        )

        XCTAssertTrue(try CashuNostrPaymentInboxStore.enqueue(current, at: url, now: now))
        XCTAssertFalse(try CashuNostrPaymentInboxStore.enqueue(current, at: url, now: now))
        XCTAssertTrue(try CashuNostrPaymentInboxStore.enqueue(expired, at: url, now: now))
        XCTAssertEqual(CashuNostrPaymentInboxStore.load(from: url, now: now), [current])

        try CashuNostrPaymentInboxStore.remove(eventIDs: [current.eventID], at: url, now: now)
        XCTAssertTrue(CashuNostrPaymentInboxStore.load(from: url, now: now).isEmpty)
    }

    func testTransactionSummaryDefaultsToEcashWithoutPaymentMetadata() {
        let transaction = CashuTransactionSummary(
            id: "transaction",
            mintURL: "https://mint.example",
            direction: .outgoing,
            amount: 21,
            fee: 1,
            date: Date(timeIntervalSince1970: 1_000),
            memo: nil
        )

        XCTAssertEqual(transaction.kind, .ecash)
        XCTAssertNil(transaction.quoteID)
        XCTAssertNil(transaction.paymentRequest)
        XCTAssertNil(transaction.paymentProof)
        XCTAssertNil(transaction.cashuToken)
        XCTAssertNil(transaction.cashuPaymentRequest)
        XCTAssertEqual(transaction.state, .completed)
        XCTAssertNil(transaction.outgoingTokenStatus)
        XCTAssertNil(transaction.outgoingTokenID)
    }

    func testOutgoingTokenStatusAggregatesProofRedemption() {
        XCTAssertEqual(CashuWalletService.outgoingTokenStatus(for: []), .ready)
        XCTAssertEqual(CashuWalletService.outgoingTokenStatus(for: [false, false]), .ready)
        XCTAssertEqual(CashuWalletService.outgoingTokenStatus(for: [true, false]), .partiallyRedeemed)
        XCTAssertEqual(CashuWalletService.outgoingTokenStatus(for: [true, true]), .redeemed)
    }

    func testOutgoingTokenJournalDecodesBeforeProofStateFieldsExisted() throws {
        let json = """
        {
          "id":"token-id",
          "operationID":"operation-id",
          "mintURL":"https://mint.example",
          "amount":21,
          "fee":1,
          "token":"cashuAlegacy",
          "createdAt":1000,
          "status":"ready"
        }
        """

        let outgoing = try JSONDecoder().decode(
            CashuOutgoingToken.self,
            from: Data(json.utf8)
        )

        XCTAssertEqual(outgoing.status, .ready)
        XCTAssertNil(outgoing.lastCheckedAt)
        XCTAssertNil(outgoing.spentProofCount)
        XCTAssertNil(outgoing.proofCount)
    }

    func testPaymentArtifactJournalDecodesRecordsCreatedBeforeStateTracking() throws {
        let json = """
        [{
          "id":"legacy",
          "quoteID":"quote-id",
          "mintURL":"https://mint.example",
          "direction":"outgoing",
          "kind":"lightning",
          "value":"lnbc21u1legacy",
          "amount":2100,
          "createdAt":1000
        }]
        """

        let records = try JSONDecoder().decode(
            [CashuPaymentArtifactRecord].self,
            from: Data(json.utf8)
        )

        XCTAssertEqual(records.first?.value, "lnbc21u1legacy")
        XCTAssertNil(records.first?.state)
        XCTAssertNil(records.first?.lastCheckedAt)
        XCTAssertNil(records.first?.feePaid)
        XCTAssertNil(records.first?.paymentProof)
        XCTAssertNil(records.first?.cashuToken)
    }

    func testPendingLightningArtifactStateRoundTrips() throws {
        let record = CashuPaymentArtifactRecord(
            id: "pending",
            quoteID: "quote-id",
            mintURL: "https://mint.example",
            direction: .outgoing,
            kind: .lightning,
            value: "lnbc21u1pending",
            amount: 2_100,
            createdAt: Date(timeIntervalSince1970: 1_000),
            state: .pending,
            lastCheckedAt: Date(timeIntervalSince1970: 1_010),
            expiresAt: Date(timeIntervalSince1970: 2_000)
        )

        let decoded = try JSONDecoder().decode(
            CashuPaymentArtifactRecord.self,
            from: JSONEncoder().encode(record)
        )

        XCTAssertEqual(decoded, record)
        XCTAssertEqual(decoded.state, .pending)
    }

    func testPaymentArtifactJournalRoundTripsOriginalPaymentValues() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskify-payment-artifacts-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("artifacts.json")
        let records = [
            CashuPaymentArtifactRecord(
                id: "token",
                transactionID: "transaction-id",
                operationID: "operation-id",
                mintURL: "https://mint.example",
                direction: .outgoing,
                kind: .ecash,
                value: "cashuAoriginal",
                amount: 21,
                createdAt: Date(timeIntervalSince1970: 1_000)
            ),
            CashuPaymentArtifactRecord(
                id: "invoice",
                quoteID: "quote-id",
                mintURL: "https://mint.example",
                direction: .incoming,
                kind: .lightning,
                value: "lnbc21u1original",
                amount: 2_100,
                createdAt: Date(timeIntervalSince1970: 2_000)
            ),
        ]
        try JSONEncoder().encode(records).write(to: url, options: .atomic)

        XCTAssertEqual(CashuWalletService.loadPaymentArtifacts(from: url), records)
    }

    func testIncomingPaymentRequestJournalAppearsInHistoryWithoutCDKTransaction() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskify-request-history-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let outgoingURL = directory.appendingPathComponent("outgoing.json")
        let artifactURL = outgoingURL
            .deletingPathExtension()
            .appendingPathExtension("payment-artifacts.json")
        let artifact = CashuPaymentArtifactRecord(
            id: "payment-request-receive:event-1",
            operationID: "payment-request-receive:event-1",
            mintURL: "https://mint.example",
            direction: .incoming,
            kind: .ecash,
            value: "creqB1example",
            valueKind: .cashuPaymentRequest,
            cashuToken: "cashuAfulfilled",
            amount: 42,
            memo: "Request payment",
            state: .completed
        )
        try JSONEncoder().encode([artifact]).write(to: artifactURL, options: .atomic)
        let service = try CashuWalletService(
            databaseURL: directory.appendingPathComponent("wallet.sqlite"),
            outgoingTokensURL: outgoingURL,
            mnemonic: CashuWalletService.generateMnemonic()
        )

        let snapshot = await service.snapshot()

        XCTAssertEqual(snapshot.transactions.count, 1)
        XCTAssertEqual(snapshot.transactions[0].direction, .incoming)
        XCTAssertEqual(snapshot.transactions[0].amount, 42)
        XCTAssertEqual(snapshot.transactions[0].cashuToken, "cashuAfulfilled")
        XCTAssertEqual(snapshot.transactions[0].cashuPaymentRequest, "creqB1example")
        XCTAssertEqual(snapshot.transactions[0].state, .completed)
    }

    func testPaymentArtifactMatchingUsesStableIdentifiersBeforeFingerprint() throws {
        let date = Date(timeIntervalSince1970: 10_000)
        let expected = CashuPaymentArtifactRecord(
            id: "expected",
            quoteID: "quote-id",
            mintURL: "https://mint.example",
            direction: .outgoing,
            kind: .lightning,
            value: "lnbc21u1expected",
            amount: 2_100,
            createdAt: date.addingTimeInterval(-3_600)
        )
        let nearbyButWrong = CashuPaymentArtifactRecord(
            id: "nearby",
            mintURL: "https://mint.example",
            direction: .outgoing,
            kind: .lightning,
            value: "lnbc21u1nearby",
            amount: 2_100,
            createdAt: date
        )

        let match = CashuWalletService.matchingPaymentArtifact(
            in: [nearbyButWrong, expected],
            transactionID: "transaction-id",
            operationID: nil,
            quoteID: "quote-id",
            mintURL: "https://mint.example",
            direction: .outgoing,
            kind: .lightning,
            amount: 2_100,
            date: date
        )

        XCTAssertEqual(match, expected)
    }

    func testPaymentArtifactFingerprintRefusesAmbiguousTokens() {
        let date = Date(timeIntervalSince1970: 10_000)
        let records = ["cashuAone", "cashuAtwo"].enumerated().map { offset, token in
            CashuPaymentArtifactRecord(
                id: "\(offset)",
                mintURL: "https://mint.example",
                direction: .incoming,
                kind: .ecash,
                value: token,
                amount: 21,
                createdAt: date.addingTimeInterval(TimeInterval(offset))
            )
        }

        let match = CashuWalletService.matchingPaymentArtifact(
            in: records,
            transactionID: "unknown",
            operationID: nil,
            quoteID: nil,
            mintURL: "https://mint.example",
            direction: .incoming,
            kind: .ecash,
            amount: 21,
            date: date
        )

        XCTAssertNil(match)
    }

    func testLightningReceiveJournalKeepsMultipleOutstandingInvoices() async throws {
        let mnemonic = try CashuWalletService.generateMnemonic()
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskify-lightning-journal-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let outgoingURL = directory.appendingPathComponent("outgoing.json")
        let journalURL = outgoingURL
            .deletingPathExtension()
            .appendingPathExtension("lightning-receive.json")
        let now = Date(timeIntervalSince1970: 10_000)
        let quotes = [
            CashuLightningReceiveQuote(
                id: "older-active",
                mintURL: "https://mint.example",
                amount: 100,
                invoice: "lnbc1older",
                createdAt: now.addingTimeInterval(-20),
                expiresAt: now.addingTimeInterval(60),
                state: .unpaid,
                issuedAmount: 0
            ),
            CashuLightningReceiveQuote(
                id: "newer-active",
                mintURL: "https://mint.example",
                amount: 200,
                invoice: "lnbc1newer",
                createdAt: now.addingTimeInterval(-10),
                expiresAt: now.addingTimeInterval(60),
                state: .unpaid,
                issuedAmount: 0
            ),
            CashuLightningReceiveQuote(
                id: "expired",
                mintURL: "https://mint.example",
                amount: 300,
                invoice: "lnbc1expired",
                createdAt: now.addingTimeInterval(-30),
                expiresAt: now.addingTimeInterval(-1),
                state: .unpaid,
                issuedAmount: 0
            ),
        ]
        try JSONEncoder().encode(quotes).write(to: journalURL, options: .atomic)

        let service = try CashuWalletService(
            databaseURL: directory.appendingPathComponent("wallet.sqlite"),
            outgoingTokensURL: outgoingURL,
            mnemonic: mnemonic
        )
        let tracked = try await service.trackedLightningReceiveQuotes(at: now)
        let latest = try await service.latestLightningReceiveQuote(
            mintURL: "https://mint.example",
            at: now
        )

        XCTAssertEqual(tracked.map(\.id), ["newer-active", "older-active", "expired"])
        XCTAssertEqual(tracked.last?.state, .expired)
        XCTAssertEqual(latest?.id, "newer-active")
    }

    func testGeneratedWalletMnemonicIsNonEmpty() throws {
        let mnemonic = try CashuWalletService.generateMnemonic()
        XCTAssertGreaterThanOrEqual(mnemonic.split(separator: " ").count, 12)
    }

    func testCounterDesynchronizationMessagesMatchKnownMintErrors() {
        XCTAssertTrue(CashuWalletService.isCounterDesynchronizationMessage("Duplicate outputs"))
        XCTAssertTrue(CashuWalletService.isCounterDesynchronizationMessage("Blinded Message is already signed"))
        XCTAssertTrue(CashuWalletService.isCounterDesynchronizationMessage("Outputs already signed by mint"))
        XCTAssertFalse(CashuWalletService.isCounterDesynchronizationMessage("Token has already been spent"))
    }

    func testPlainRecoveryPhraseIsNormalizedAndValidated() throws {
        let mnemonic = try CashuWalletService.generateMnemonic()
        let padded = "  \(mnemonic.replacingOccurrences(of: " ", with: "  \n"))  "

        let material = try CashuWalletService.parseRecoveryMaterial(padded)

        XCTAssertEqual(material.mnemonic, mnemonic)
        XCTAssertTrue(material.mintURLs.isEmpty)
        XCTAssertTrue(CashuWalletService.validateMnemonic(material.mnemonic))
    }

    func testPWASeedBackupRecoversNestedMnemonicAndMintURLs() throws {
        let mnemonic = try CashuWalletService.generateMnemonic()
        let payload: [String: Any] = [
            "cashu": [
                "walletSeed": [
                    "type": "nut13-wallet-backup",
                    "version": 1,
                    "mnemonic": mnemonic,
                    "counters": [
                        "https://mint.solife.me/": ["keyset": 42],
                        "https://mint.example": [:],
                        "http://public-insecure.example": [:],
                    ],
                ],
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: payload)
        let json = try XCTUnwrap(String(data: data, encoding: .utf8))

        let material = try CashuWalletService.parseRecoveryMaterial(json)

        XCTAssertEqual(material.mnemonic, mnemonic)
        XCTAssertEqual(material.mintURLs, ["https://mint.example", "https://mint.solife.me"])
    }

    func testWalletIdentifierIsStableWithoutExposingMnemonic() throws {
        let mnemonic = try CashuWalletService.generateMnemonic()
        let identifier = try CashuWalletService.walletIdentifier(for: mnemonic)

        XCTAssertEqual(identifier, try CashuWalletService.walletIdentifier(for: mnemonic))
        XCTAssertEqual(identifier.count, 16)
        XCTAssertFalse(mnemonic.contains(identifier))
    }

    func testNativeSeedBackupRoundTripsThroughPWAEnvelope() async throws {
        let mnemonic = try CashuWalletService.generateMnemonic()
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskify-cashu-backup-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let service = try CashuWalletService(
            databaseURL: directory.appendingPathComponent("wallet.sqlite"),
            outgoingTokensURL: directory.appendingPathComponent("outgoing.json"),
            mnemonic: mnemonic
        )
        let json = try await service.seedBackupJSON()
        let material = try CashuWalletService.parseRecoveryMaterial(json)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        )

        XCTAssertEqual(object["type"] as? String, "nut13-wallet-backup")
        XCTAssertEqual((object["version"] as? NSNumber)?.intValue, 1)
        XCTAssertEqual(material.mnemonic, mnemonic)
        XCTAssertTrue(material.mintURLs.isEmpty)
    }
}
