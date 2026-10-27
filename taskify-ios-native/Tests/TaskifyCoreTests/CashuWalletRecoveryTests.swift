import Cdk
import Foundation
import XCTest
@testable import TaskifyCore
@testable import TaskifyWallet

/// C9-2: the recovery view's tokens are standard and complete, made from storage alone.
final class CashuWalletRecoveryTests: XCTestCase {
    func testStoredProofsBecomeATokenEveryWalletReads() throws {
        let proofs = [
            Proof(amount: Amount(value: 8), secret: "secret-one", c: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
                  keysetId: "009a1f293253e41e", witness: nil, dleq: nil, p2pkE: nil),
            Proof(amount: Amount(value: 2), secret: "secret-two", c: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
                  keysetId: "009a1f293253e41e", witness: nil, dleq: nil, p2pkE: nil),
        ]
        let encoded = try CashuWalletRecovery.encodeV3Token(mintURL: "https://mint.example", proofs: proofs)
        XCTAssertTrue(encoded.hasPrefix("cashuA"))
        let token = try Token.decode(encodedToken: encoded)
        XCTAssertEqual(try token.mintUrl().url, "https://mint.example")
        XCTAssertEqual(try token.value().value, 10)
        XCTAssertEqual(try token.proofsSimple().map(\.secret), ["secret-one", "secret-two"])
    }

    func testMissingFilesGiveAnEmptySnapshot() async {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let snapshot = await CashuWalletRecovery.load(
            databaseURL: directory.appendingPathComponent("none.sqlite"),
            outgoingTokensURL: directory.appendingPathComponent("outgoing.json"),
            pendingReceivesURL: directory.appendingPathComponent("pending.json")
        )
        XCTAssertTrue(snapshot.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path), "reading writes nothing")
    }

    func testEachMintsUnspentNotesBecomeOneTokenFromTheDatabase() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let databaseURL = directory.appendingPathComponent("cashu.sqlite")
        let database = try WalletSqliteDatabase(filePath: databaseURL.path)
        func info(_ secret: String, _ amount: UInt64, mint: String, state: ProofState) throws -> ProofInfo {
            let proof = Proof(amount: Amount(value: amount), secret: secret,
                              c: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
                              keysetId: "009a1f293253e41e", witness: nil, dleq: nil, p2pkE: nil)
            return ProofInfo(proof: proof, y: PublicKey(hex: try CashuNUT07.hashToCurve(Data(secret.utf8)).hexString),
                             mintUrl: MintUrl(url: mint), state: state, spendingCondition: nil, unit: .sat,
                             derivationIndex: nil, usedByOperation: nil, createdByOperation: nil)
        }
        for mint in ["https://a.example", "https://b.example"] {
            try await database.addMint(mintUrl: MintUrl(url: mint), mintInfo: nil)
        }
        try await database.updateProofs(added: [
            try info("a1", 8, mint: "https://a.example", state: .unspent),
            try info("a2", 2, mint: "https://a.example", state: .reserved),
            try info("a3", 32, mint: "https://a.example", state: .spent),
            try info("b1", 4, mint: "https://b.example", state: .unspent),
        ], removedYs: [])

        let snapshot = await CashuWalletRecovery.load(
            databaseURL: databaseURL,
            outgoingTokensURL: directory.appendingPathComponent("outgoing.json"),
            pendingReceivesURL: directory.appendingPathComponent("pending.json")
        )
        XCTAssertEqual(snapshot.mints.map(\.mintURL), ["https://a.example", "https://b.example"])
        XCTAssertEqual(snapshot.mints.map(\.amount), [10, 4], "spent notes are left out")
        let tokenA = try Token.decode(encodedToken: snapshot.mints[0].token)
        XCTAssertEqual(Set(try tokenA.proofsSimple().map(\.secret)), ["a1", "a2"])
    }
}
