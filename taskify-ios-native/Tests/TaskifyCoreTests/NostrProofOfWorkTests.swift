import XCTest
import TaskifyWatchShared
@testable import TaskifyCore

final class NostrProofOfWorkTests: XCTestCase {
    func testNativeAndWatchMineBeforeSigning() throws {
        let key = Data(repeating: 1, count: 32)
        try TaskifyRelayProofOfWork.$difficulty.withValue(8) {
            let event = try NostrEvent.signed(privateKey: key, createdAt: 1234, kind: 1059,
                tags: [["p", String(repeating: "a", count: 64)]], content: "encrypted")
            XCTAssertTrue(event.verify())
            XCTAssertGreaterThanOrEqual(TaskifyRelayProofOfWork.leadingZeroBits(event.id), 8)
            XCTAssertEqual(event.tags.last?.last, "8")
            XCTAssertEqual(event.createdAt, 1234)
            let watch = try TaskifyWatchNostrCrypto.signedEvent(privateKey: key, createdAt: 1234,
                kind: 1059, tags: [["p", String(repeating: "a", count: 64)]], content: "encrypted")
            XCTAssertEqual(watch.id, event.id)
        }
    }

    func testUnsupportedWorkDoesNotSilentlyDowngrade() throws {
        XCTAssertThrowsError(try TaskifyRelayProofOfWork.$difficulty.withValue(33) {
            try NostrEvent.signed(privateKey: Data(repeating: 1, count: 32), createdAt: 1234,
                kind: 1, tags: [], content: "test")
        })
    }

    func testAuthEventsAreNotMined() throws {
        let event = try TaskifyRelayProofOfWork.$difficulty.withValue(32) {
            try NostrEvent.signed(privateKey: Data(repeating: 1, count: 32), createdAt: 1234,
                kind: 22242, tags: [["relay", "wss://example.test"], ["challenge", "c"]], content: "")
        }
        XCTAssertNil(event.firstTagValue(named: "nonce"))
    }
}
