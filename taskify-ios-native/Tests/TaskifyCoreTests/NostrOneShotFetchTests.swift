import XCTest
@testable import TaskifyCore

final class NostrOneShotFetchTests: XCTestCase {
    /// A host that accepts nothing must not hold the caller past its timeout. The one-shot
    /// fetch used to apply the timeout only after the subscription was sent, so URLSession's
    /// request timeout (60s) decided when an unreachable relay gave up — long enough for a
    /// contact delete waiting on a list refresh to look like it did nothing.
    func testUnreachableRelayReturnsWithinTimeout() async {
        let start = Date()
        let events = await NostrFreshConnectionFetcher().fetchOnce(
            filter: NostrRelayFilter(
                kinds: [NIP51ContactListContract.eventKind],
                authors: [String(repeating: "1", count: 64)],
                limit: 5
            ),
            relayURLs: ["wss://192.0.2.1:9735"],
            timeout: 1
        )
        let elapsed = Date().timeIntervalSince(start)
        XCTAssertTrue(events.isEmpty)
        XCTAssertLessThan(elapsed, 3, "fetchOnce exceeded its timeout by \(elapsed)s")
    }
}
