import XCTest
@testable import TaskifyCore

final class StartupBoardSelectionTests: XCTestCase {
    func testWeekdayOverrideAndFirstVisibleFallbackMatchPWASettings() throws {
        let first = Board.week(id: "first", name: "First")
        let preferred = Board.week(id: "preferred", name: "Preferred")
        let hidden = Board(id: "hidden", name: "Hidden", hidden: true)
        let archived = Board(id: "archived", name: "Archived", archived: true)
        let boards = [first, hidden, archived, preferred]

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let wednesday = try XCTUnwrap(calendar.date(from: DateComponents(
            year: 2026,
            month: 7,
            day: 29
        )))

        XCTAssertEqual(
            StartupBoardSelection.boardID(
                boards: boards,
                preferredBoardIDsByWeekday: [3: preferred.id],
                date: wednesday,
                calendar: calendar
            ),
            preferred.id
        )
        XCTAssertEqual(
            StartupBoardSelection.boardID(
                boards: boards,
                preferredBoardIDsByWeekday: [3: hidden.id],
                date: wednesday,
                calendar: calendar
            ),
            first.id
        )
        XCTAssertEqual(
            StartupBoardSelection.boardID(
                boards: boards,
                preferredBoardIDsByWeekday: [:],
                date: wednesday,
                calendar: calendar
            ),
            first.id
        )
    }

    func testPreferenceCleanupDropsInvalidWeekdaysAndUnavailableBoards() {
        let visible = Board.week(id: "visible", name: "Visible")
        let archived = Board(id: "archived", name: "Archived", archived: true)
        let hidden = Board(id: "hidden", name: "Hidden", hidden: true)

        XCTAssertEqual(
            StartupBoardSelection.sanitizedPreferences(
                [
                    -1: visible.id,
                    0: visible.id,
                    1: archived.id,
                    2: hidden.id,
                    3: "missing",
                    7: visible.id,
                ],
                boards: [visible, archived, hidden]
            ),
            [0: visible.id]
        )
    }
}
