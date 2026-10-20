import Foundation
import XCTest
@testable import TaskifyCore
@testable import TaskifyWallet

/// C9-3: saved tokens no longer block close-out forever. A token already redeemed in another
/// wallet is found with its mint (NUT-07) and removed, keeping a copy; one that cannot be checked
/// can be removed by the user; an unspent one is money, so it stays until moved out.
final class CashuSavedTokenCloseOutTests: XCTestCase {
    /// NUT-00 hash_to_curve test vectors.
    func testHashToCurveMatchesTheSpecification() throws {
        let vectors = [
            ("0000000000000000000000000000000000000000000000000000000000000000",
             "024cce997d3b518f739663b757deaec95bcd9473c30a14ac2fd04023a739d1a725"),
            ("0000000000000000000000000000000000000000000000000000000000000001",
             "022e7158e11c9506f1aa4248bf531298daa7febd6194f003edcd9b93ade6253acf"),
            ("0000000000000000000000000000000000000000000000000000000000000002",
             "026cdbe15362df59cd1dd3c9c11de8aedac2106eca69236ecd9fbe117af897be4f"),
        ]
        for (message, expected) in vectors {
            let y = try CashuNUT07.hashToCurve(Data(hex: message))
            XCTAssertEqual(y.hexString, expected)
        }
    }

    private static func token(secrets: [String], mint: String = "https://mint.example") -> String {
        let proofs = secrets.map {
            #"{"amount":2,"id":"009a1f293253e41e","secret":"\#($0)","C":"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"}"#
        }.joined(separator: ",")
        let json = #"{"token":[{"mint":"\#(mint)","proofs":[\#(proofs)]}],"unit":"sat"}"#
        return "cashuA" + Data(json.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// A mint answering checkstate with `state` for every Y it is asked about.
    private func mint(_ state: String, calls: Box<[URL]>? = nil) -> CashuNUT07.Post {
        { url, body in
            calls?.value.append(url)
            let request = try JSONSerialization.jsonObject(with: body) as! [String: [String]]
            let states = request["Ys"]!.map { ["Y": $0, "state": state] }
            return try JSONSerialization.data(withJSONObject: ["states": states])
        }
    }

    final class Box<T> { var value: T; init(_ value: T) { self.value = value } }

    func testATokenRedeemedElsewhereIsSpent() async {
        let calls = Box<[URL]>([])
        let state = await CashuNUT07.state(ofToken: Self.token(secrets: ["a", "b"]), post: mint("SPENT", calls: calls))
        XCTAssertEqual(state, .spent)
        XCTAssertEqual(calls.value.map(\.absoluteString), ["https://mint.example/v1/checkstate"])
    }

    func testAnyUnspentProofKeepsTheToken() async {
        let state = await CashuNUT07.state(ofToken: Self.token(secrets: ["a"]), post: mint("UNSPENT"))
        XCTAssertEqual(state, .unspent)
    }

    func testAnUnreachableMintCannotBeChecked() async {
        let state = await CashuNUT07.state(ofToken: Self.token(secrets: ["a"])) { _, _ in
            throw URLError(.notConnectedToInternet)
        }
        XCTAssertEqual(state, .unknown)
        let garbage = await CashuNUT07.state(ofToken: "cashuBnot-a-token", post: mint("SPENT"))
        XCTAssertEqual(garbage, .unknown)
    }

    func testTheCloseOutPlanRemovesSpentKeepsMoneyAndOffersUncheckedForRemoval() {
        let spent = CashuSavedToken(id: "spent", source: .pendingReceive, token: "t1", amount: 5, mintURL: "m")
        let unspent = CashuSavedToken(id: "unspent", source: .incomingToken, token: "t2", amount: 8, mintURL: "m")
        let unknown = CashuSavedToken(id: "unknown", source: .paymentDelivery, token: "t3", amount: nil, mintURL: nil)
        let plan = CashuSavedTokenCloseOutPlan(
            tokens: [spent, unspent, unknown],
            states: ["spent": .spent, "unspent": .unspent, "unknown": .unknown]
        )
        XCTAssertEqual(plan.removeAsSpent.map(\.id), ["spent"])
        XCTAssertEqual(plan.stillHoldFunds.map(\.id), ["unspent"])
        XCTAssertEqual(plan.removableByUser.map(\.id), ["unknown"])
    }

    func testRemovedTokensAreKeptInTheLog() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".json")
        defer { try? FileManager.default.removeItem(at: url) }
        let token = CashuSavedToken(id: "x", source: .pendingReceive, token: "cashuBabc", amount: 21, mintURL: "https://mint.example")
        try CashuRemovedTokenLog.append(token, reason: .spentElsewhere, at: Date(timeIntervalSince1970: 100), to: url)
        try CashuRemovedTokenLog.append(token, reason: .removedByUser, at: Date(timeIntervalSince1970: 200), to: url)
        let entries = CashuRemovedTokenLog.load(from: url)
        XCTAssertEqual(entries.map(\.reason), [.removedByUser, .spentElsewhere], "newest first")
        XCTAssertEqual(entries.first?.token, "cashuBabc")
    }
}
