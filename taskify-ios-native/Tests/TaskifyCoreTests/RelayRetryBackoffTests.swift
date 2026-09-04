import XCTest
@testable import TaskifyCore

final class RelayRetryBackoffTests: XCTestCase {
    func testPersistentFailureBacksOffInsteadOfRetryingEverySecond() {
        var backoff = RelayRetryBackoff()
        let delays = (0..<10).map { _ in backoff.nextDelay() }
        XCTAssertEqual(delays, [1, 2, 4, 8, 16, 30, 30, 30, 30, 30])
    }

    func testLongOutageStaysBoundedAndFreshConnectionCanRetryPromptly() {
        var backoff = RelayRetryBackoff()
        for _ in 0..<10_000 {
            let delay = backoff.nextDelay()
            XCTAssertTrue((1...30).contains(delay))
        }
        XCTAssertEqual(backoff.nextDelay(), 30)
        // The engine discards this state only on a relay response or an explicit retry.
        backoff = RelayRetryBackoff()
        XCTAssertEqual(backoff.nextDelay(), 1)
    }
}
