import XCTest
@testable import TaskifyCore
@testable import TaskifyWallet

/// The wallet's end date, as the PWA has it: local midnight starting December 1, 2026.
final class TaskifyWalletPhaseOutTests: XCTestCase {
    func testTheWalletEndsAtLocalMidnightOnDecemberFirst() {
        var chicago = Calendar(identifier: .gregorian)
        chicago.timeZone = TimeZone(identifier: "America/Chicago")!
        let lastMinute = chicago.date(from: DateComponents(year: 2026, month: 11, day: 30, hour: 23, minute: 59))!
        let midnight = chicago.date(from: DateComponents(year: 2026, month: 12, day: 1))!
        XCTAssertFalse(TaskifyWalletPhaseOut.isWalletRemoved(now: lastMinute, calendar: chicago))
        XCTAssertTrue(TaskifyWalletPhaseOut.isWalletRemoved(now: midnight, calendar: chicago))

        var tokyo = Calendar(identifier: .gregorian)
        tokyo.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        XCTAssertTrue(TaskifyWalletPhaseOut.isWalletRemoved(now: lastMinute, calendar: tokyo), "already December 1 in Tokyo")
    }
}
