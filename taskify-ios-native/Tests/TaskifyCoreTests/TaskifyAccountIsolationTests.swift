import XCTest
@testable import TaskifyCore

final class TaskifyAccountIsolationTests: XCTestCase {
    func testAccountScopeRequiresTwoMatchingIdentifiers() {
        let account = String(repeating: "ab", count: 32)

        XCTAssertTrue(TaskifyAccountScope.isSame(account.uppercased(), account))
        XCTAssertFalse(TaskifyAccountScope.isSame(account, String(repeating: "cd", count: 32)))
        XCTAssertFalse(TaskifyAccountScope.isSame(nil, account))
        XCTAssertFalse(TaskifyAccountScope.isSame(account, nil))
        XCTAssertFalse(TaskifyAccountScope.isSame("   ", "   "))
    }
}
