import Foundation
import XCTest
@testable import TaskifyCore

final class TaskifySnapshotTests: XCTestCase {
    func testEmptySnapshotStartsWithVisibleWeekBoard() {
        let snapshot = TaskifySnapshot.empty

        XCTAssertEqual(snapshot.visibleBoards.map(\.name), ["Week"])
        XCTAssertEqual(snapshot.selectedBoard?.kind, .week)
        XCTAssertEqual(snapshot.selectedBoard?.columns.count, 7)
    }

    func testQuickAddCreatesTrimmedTaskInRequestedDay() {
        var snapshot = TaskifySnapshot.empty
        let now = Date(timeIntervalSince1970: 1_700_000_000)

        let task = snapshot.addTask(
            title: "  Ship native slice  ",
            boardID: "week-default",
            columnID: WeekdayColumn.monday.rawValue,
            dueDate: now,
            now: now
        )

        XCTAssertEqual(task?.title, "Ship native slice")
        XCTAssertEqual(task?.columnID, "monday")
        XCTAssertEqual(snapshot.tasks.count, 1)
        XCTAssertTrue(snapshot.tasks[0].dueDateEnabled)
    }

    func testCompletionRemovesTaskFromUpcoming() {
        var snapshot = TaskifySnapshot.empty
        let dueDate = Date(timeIntervalSince1970: 1_700_086_400)
        let task = snapshot.addTask(
            title: "Review build",
            boardID: "week-default",
            columnID: WeekdayColumn.tuesday.rawValue,
            dueDate: dueDate
        )

        XCTAssertEqual(snapshot.upcomingTasks(from: Date(timeIntervalSince1970: 1_700_000_000)).count, 1)
        XCTAssertTrue(snapshot.toggleCompletion(taskID: try XCTUnwrap(task?.id), now: dueDate))
        XCTAssertTrue(snapshot.upcomingTasks(from: Date(timeIntervalSince1970: 1_700_000_000)).isEmpty)
    }

    func testJSONStoreRoundTripsSnapshot() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let fileURL = directory.appendingPathComponent("taskify.json")
        let store = JSONTaskStore(fileURL: fileURL)
        var snapshot = TaskifySnapshot.empty
        _ = snapshot.addTask(
            title: "Persist me",
            boardID: "week-default",
            columnID: WeekdayColumn.friday.rawValue,
            dueDate: Date(timeIntervalSince1970: 1_700_000_000)
        )

        try await store.save(snapshot)
        let restored = try await store.load()

        XCTAssertEqual(restored, snapshot)
        try? FileManager.default.removeItem(at: directory)
    }

    func testWeekDateResolverReturnsRequestedWeekday() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let reference = Date(timeIntervalSince1970: 1_721_260_800)

        let friday = WeekDateResolver.date(
            for: .friday,
            inWeekContaining: reference,
            calendar: calendar
        )

        XCTAssertEqual(calendar.component(.weekday, from: friday), 6)
    }
}
