import XCTest
@testable import TaskifyCore

final class NostrRelayAuthenticationTests: XCTestCase {
    func testBlockedRequestWaitsForAuthAcknowledgementAndReplaysOnce() {
        var state = NostrRelayAuthReplay()
        state.record(key: "REQ:one", frame: "request")
        XCTAssertTrue(state.block(key: "REQ:one"))
        XCTAssertTrue(state.begin(challenge: "c", authEventID: "auth"))
        XCTAssertFalse(state.begin(challenge: "c", authEventID: "duplicate"))
        XCTAssertEqual(state.takeReplays(), [])
        XCTAssertNil(state.acknowledge(eventID: "unrelated", accepted: true))
        XCTAssertEqual(state.acknowledge(eventID: "auth", accepted: true), ["request"])
        XCTAssertFalse(state.block(key: "REQ:one"))
        XCTAssertEqual(state.takeReplays(), [])
    }

    func testDeniedAuthAndClosedSubscriptionDoNotReplay() {
        var state = NostrRelayAuthReplay()
        state.record(key: "REQ:one", frame: "request")
        _ = state.block(key: "REQ:one")
        _ = state.begin(challenge: "c", authEventID: "auth")
        XCTAssertEqual(state.acknowledge(eventID: "auth", accepted: false), [])
        state.remove(key: "REQ:one")
        XCTAssertEqual(state.acknowledge(eventID: "auth", accepted: true), [])
    }
}
