import XCTest
import TaskifyCore
@testable import MacPresentation

final class MacPresentationTests: XCTestCase {
    func testNewWeekTaskAppearsInTodayColumnAcrossDaylightSavingBoundary() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "America/Chicago"))
        let now = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 3, day: 8, hour: 16)))
        let board = Board.week(id: "week")
        let draft = MacTaskDraft.place(TaskItem(boardID: "old", title: "Plan the week"), on: board,
                                      now: now, weekStartsOn: .monday, calendar: calendar)
        XCTAssertTrue(draft.dueDateEnabled)
        XCTAssertEqual(draft.columnID, WeekdayColumn.sunday.rawValue)
        XCTAssertTrue(calendar.isDate(try XCTUnwrap(draft.dueDate), inSameDayAs: now))
        let snapshot = TaskifySnapshot(boards: [board], tasks: [draft], selectedBoardID: board.id)
        XCTAssertEqual(snapshot.tasks(boardID: board.id, columnID: "sunday", includeCompleted: false,
                                      now: now, weekStartsOn: .monday, calendar: calendar).map(\.id), [draft.id])
    }

    func testMovingDraftToListUsesColumnOrderAndPreservesDateAndContents() {
        let due = Date(timeIntervalSince1970: 1_800_000_000)
        let task = TaskItem(boardID: "week", title: "Keep this", note: "Notes", dueDate: due,
                            dueDateEnabled: true, priority: .high, subtasks: [TaskSubtask(title: "First")])
        let board = Board(id: "list", name: "Studio", kind: .list, columns: [
            BoardColumn(id: "later", name: "Later", order: 5), BoardColumn(id: "first", name: "First", order: 0),
        ])
        let draft = MacTaskDraft.place(task, on: board, weekStartsOn: .monday)
        XCTAssertEqual(draft.boardID, "list")
        XCTAssertEqual(draft.columnID, "first")
        XCTAssertEqual(draft.dueDate, due)
        XCTAssertEqual(draft.subtasks, task.subtasks)
        XCTAssertEqual(draft.note, task.note)
        XCTAssertEqual(draft.priority, .high)
    }

    func testPendingLightningIsNotPresentedAsPaid() {
        let payment = CashuLightningPaymentResult(quoteID: "quote", mintURL: "https://mint.example", amount: 100,
                                                  feePaid: nil, preimage: nil, state: .pending)
        let outcome = MacWalletOutcome(payment: payment)
        XCTAssertEqual(outcome, .paymentPending)
        XCTAssertTrue(outcome.isPending)
        XCTAssertNotEqual(outcome, .paid)
    }

    func testQueuedAndPreviouslyReceivedTokensAreNotPresentedAsNewReceipts() {
        let queued = CashuPendingReceive(id: "receive", token: "fixture", mintURL: "https://mint.example",
                                         amount: 100, memo: nil, createdAt: Date())
        XCTAssertEqual(MacWalletOutcome(receive: .queued(queued)), .receiveQueued)
        XCTAssertTrue(MacWalletOutcome(receive: .queued(queued)).isPending)
        XCTAssertEqual(MacWalletOutcome(receive: .alreadyReceived(100)), .alreadyReceived)
        XCTAssertNotEqual(MacWalletOutcome(receive: .alreadyReceived(100)), .received(100))
        XCTAssertEqual(MacWalletOutcome(receive: .received(100)), .received(100))
    }
    @MainActor
    func testRecoveryUsesModeConfirmedBeforeAuthentication() async throws {
        var replace = false
        var executedReplacement: Bool?
        try await macAuthenticatedRecovery(replace: replace, authenticate: {
            replace = true
        }, recover: { executedReplacement = $0 })
        XCTAssertEqual(executedReplacement, false)
    }

    func testPaymentRequestMintSelectionPrefersOverlapWithWallet() {
        let result = MacPaymentRequestMintSelection.candidates(requestedMintURLs: ["a", "b"], walletMintURLs: ["b", "c"])
        XCTAssertEqual(result, ["b"])
    }

    func testPaymentRequestMintSelectionFallsBackToWalletMintsWhenNoOverlap() {
        let result = MacPaymentRequestMintSelection.candidates(requestedMintURLs: ["a"], walletMintURLs: ["b", "c"])
        XCTAssertEqual(result, ["b", "c"])
    }

    func testPaymentRequestMintSelectionFallsBackToWalletMintsWhenRequestNamesNone() {
        let result = MacPaymentRequestMintSelection.candidates(requestedMintURLs: [], walletMintURLs: ["b", "c"])
        XCTAssertEqual(result, ["b", "c"])
    }

    func testRecurrenceBuilderKeepReturnsExistingUnchanged() {
        let existing = TaskRecurrence.daily(until: nil)
        let result = MacRecurrenceBuilder.build(choice: "keep", referenceDate: Date(), weeklyDays: [], monthlyInterval: 1,
            interval: 1, intervalUnit: .day, until: nil, existing: existing)
        XCTAssertEqual(result, existing)
    }

    func testRecurrenceBuilderNoneClearsRecurrenceRegardlessOfExisting() {
        let result = MacRecurrenceBuilder.build(choice: "none", referenceDate: Date(), weeklyDays: [1, 3], monthlyInterval: 2,
            interval: 5, intervalUnit: .week, until: nil, existing: .daily(until: nil))
        XCTAssertNil(result)
    }

    func testRecurrenceBuilderWeeklySortsMultipleSelectedDays() {
        let result = MacRecurrenceBuilder.build(choice: "weekly", referenceDate: Date(), weeklyDays: [5, 0, 3], monthlyInterval: 1,
            interval: 1, intervalUnit: .day, until: nil, existing: nil)
        XCTAssertEqual(result, .weekly(days: [0, 3, 5], until: nil))
    }

    func testRecurrenceBuilderMonthlyUsesReferenceDateDayAndGivenInterval() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "UTC"))
        let reference = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 3, day: 17)))
        let result = MacRecurrenceBuilder.build(choice: "monthly", referenceDate: reference, weeklyDays: [], monthlyInterval: 3,
            interval: 1, intervalUnit: .day, until: nil, existing: nil, calendar: calendar)
        XCTAssertEqual(result, .monthlyDay(day: 17, interval: 3, until: nil))
    }

    func testRecurrenceBuilderIntervalCarriesUntilDate() {
        let until = Date(timeIntervalSince1970: 2_000_000_000)
        let result = MacRecurrenceBuilder.build(choice: "interval", referenceDate: Date(), weeklyDays: [], monthlyInterval: 1,
            interval: 3, intervalUnit: .hour, until: until, existing: nil)
        XCTAssertEqual(result, .every(3, .hour, until: until))
    }
}
