import XCTest
@testable import TaskifyCore

/// C9-5: the PWA's first-run rules (`onboarding/firstRunRules.ts`), the same on iOS.
final class FirstRunRulesTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_792_000_000)

    func testAKeyMadeHereIsWorthSavingAfterThreeTasksOrADay() {
        let state = KeyBackupState(createdHereAt: start)
        XCTAssertFalse(state.isPromptDue(now: start.addingTimeInterval(60), taskCount: 2))
        XCTAssertTrue(state.isPromptDue(now: start.addingTimeInterval(60), taskCount: 3))
        XCTAssertTrue(state.isPromptDue(now: start.addingTimeInterval(24 * 3600), taskCount: 0))
    }

    func testABroughtOrSavedKeyIsNeverPromptedAndNotNowWaitsThreeDays() {
        XCTAssertFalse(KeyBackupState().isPromptDue(now: start, taskCount: 10), "a key the user brought is theirs already")
        var saved = KeyBackupState(createdHereAt: start)
        saved.savedAt = start
        XCTAssertFalse(saved.isPromptDue(now: start.addingTimeInterval(3 * 86_400), taskCount: 10))

        var snoozed = KeyBackupState(createdHereAt: start)
        snoozed.snooze(now: start.addingTimeInterval(86_400))
        XCTAssertFalse(snoozed.isPromptDue(now: start.addingTimeInterval(2 * 86_400), taskCount: 10))
        XCTAssertTrue(snoozed.isPromptDue(now: start.addingTimeInterval(4 * 86_400 + 1), taskCount: 10))
    }
}
