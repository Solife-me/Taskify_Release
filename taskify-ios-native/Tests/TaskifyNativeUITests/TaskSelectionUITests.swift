import XCTest

/// Runtime verification for Boards multi-select, ported from the PWA's selection bar
/// (`useSelectionMode` / `SelectionOverlays.tsx`): enter selection mode, select tasks, then bulk
/// Delete. "Move" and "Complete" reuse existing, already-tested single-task AppModel methods
/// (`moveTask`/`toggleCompletion`) looped over the selection, so this focuses on the part that's
/// actually new: the selection UI state machine and the bulk-delete wiring.
final class TaskSelectionUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testSelectTasksThenBulkDelete() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launch()

        app.buttons["Boards"].tap()

        let quickAddField = app.textFields.matching(
            NSPredicate(format: "label BEGINSWITH[c] %@", "New task in")
        ).firstMatch
        XCTAssertTrue(quickAddField.waitForExistence(timeout: 10))
        quickAddField.tap()
        quickAddField.typeText("Selection test task A")
        quickAddField.typeText("\n")
        quickAddField.typeText("Selection test task B")
        quickAddField.typeText("\n")

        let taskA = app.buttons["Edit Selection test task A"]
        let taskB = app.buttons["Edit Selection test task B"]
        XCTAssertTrue(taskA.waitForExistence(timeout: 5))
        XCTAssertTrue(taskB.waitForExistence(timeout: 5))

        try enterSelectionMode(app)
        attach(app, name: "selection-01-mode-entered")

        // In selection mode, the entire card becomes one selection target, including previews.
        app.buttons["Select Selection test task A"].tap()
        app.buttons["Select Selection test task B"].tap()

        XCTAssertTrue(app.staticTexts["2 selected"].waitForExistence(timeout: 5))
        attach(app, name: "selection-02-two-selected")

        app.buttons["Delete"].tap()

        // Bulk delete exits selection mode and removes both tasks.
        XCTAssertTrue(app.staticTexts["2 selected"].waitForNonExistence(timeout: 5), "Should exit selection mode after bulk delete")
        XCTAssertFalse(taskA.waitForExistence(timeout: 3), "Deleted task A should no longer exist")
        XCTAssertFalse(taskB.exists, "Deleted task B should no longer exist")
        attach(app, name: "selection-03-after-bulk-delete")
    }

    /// Regression: the selection bar's Move sheet offered week boards and their days, but the
    /// core move refused any task arriving from another board, so the move silently did nothing.
    func testMovingAListTaskOntoAWeekDayFromSelection() throws {
        let app = launchWithListBoard()

        let task = app.buttons["Edit Move me"]
        XCTAssertTrue(task.waitForExistence(timeout: 10))
        try enterSelectionMode(app)
        app.buttons["Select Move me"].tap()
        app.buttons["Move"].tap()

        let weekBoard = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "UI Test Board")).firstMatch
        XCTAssertTrue(weekBoard.waitForExistence(timeout: 5))
        weekBoard.tap()
        let today = app.buttons[todayShortName]
        XCTAssertTrue(today.waitForExistence(timeout: 5))
        today.tap()
        attach(app, name: "move-01-after-selection-move")

        XCTAssertTrue(task.waitForNonExistence(timeout: 5), "The task should leave the list board")
        openBoard("UI Test Board", from: "UI Test List", in: app)
        XCTAssertTrue(task.waitForExistence(timeout: 10), "The task should be on today's column of the week board")
    }

    func testTaskEditorBoardPickerMovesAListTaskOntoAWeekBoard() throws {
        let app = launchWithListBoard()

        let task = app.buttons["Edit Move me"]
        XCTAssertTrue(task.waitForExistence(timeout: 10))
        task.tap()
        XCTAssertTrue(app.navigationBars["Edit Task"].waitForExistence(timeout: 5))

        let picker = app.buttons["task-editor-board"]
        for _ in 0..<6 where !picker.isHittable { app.swipeUp() }
        XCTAssertTrue(picker.isHittable)
        picker.tap()
        let weekOption = app.buttons["UI Test Board"]
        XCTAssertTrue(weekOption.waitForExistence(timeout: 5))
        weekOption.tap()
        attach(app, name: "move-02-editor-board-picked")
        app.buttons["Save"].tap()

        XCTAssertTrue(task.waitForNonExistence(timeout: 5), "The task should leave the list board")
        openBoard("UI Test Board", from: "UI Test List", in: app)
        XCTAssertTrue(task.waitForExistence(timeout: 10), "The task should be on the week board, on its date")
    }

    func testCopyTaskThenPasteIntoNewTaskCreatesTheTask() throws {
        let app = launchWithListBoard()

        let original = app.buttons["Edit Move me"]
        XCTAssertTrue(original.waitForExistence(timeout: 10))
        original.press(forDuration: 1.5)
        let copy = app.buttons["Copy Task"]
        XCTAssertTrue(copy.waitForExistence(timeout: 5))
        copy.tap()

        let quickAdd = app.textFields.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "New task in")).firstMatch
        XCTAssertTrue(quickAdd.waitForExistence(timeout: 5))
        quickAdd.tap()
        quickAdd.press(forDuration: 1.2)
        let paste = app.menuItems["Paste"].exists ? app.menuItems["Paste"] : app.buttons["Paste"]
        XCTAssertTrue(paste.waitForExistence(timeout: 5))
        paste.tap()
        quickAdd.typeText("\n")
        attach(app, name: "copy-01-after-paste")

        let copies = app.buttons.matching(NSPredicate(format: "label == %@", "Edit Move me"))
        let deadline = Date().addingTimeInterval(5)
        while copies.count < 2, Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.2)) }
        XCTAssertEqual(copies.count, 2, "Pasting the copied JSON should add the task, not a task titled with JSON")
    }

    /// Selection mode starts from a column's menu: "More" on a week day, "Manage … list" on a list.
    private func enterSelectionMode(_ app: XCUIApplication) throws {
        // Each column has a More menu; use the one on screen (neighbouring columns peek in).
        let menus = app.buttons.matching(NSPredicate(format: "label == 'More' OR label BEGINSWITH 'Manage '"))
        XCTAssertTrue(menus.firstMatch.waitForExistence(timeout: 5))
        let width = app.windows.firstMatch.frame.width
        let more = try XCTUnwrap(menus.allElementsBoundByIndex.first { $0.frame.minX >= 0 && $0.frame.maxX <= width })
        more.tap()
        let select = app.buttons["Select items"]
        XCTAssertTrue(select.waitForExistence(timeout: 5))
        select.tap()
    }

    private var todayShortName: String {
        ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][Calendar.current.component(.weekday, from: Date()) - 1]
    }

    private func launchWithListBoard() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_BOARD_FIXTURE"] = "1"
        app.launchEnvironment["TASKIFY_UI_TEST_LIST_BOARD"] = "1"
        app.launch()
        app.buttons["Boards"].tap()
        // Startup opens the week board; the task starts on the list board.
        openBoard("UI Test List", from: "UI Test Board", in: app)
        return app
    }

    private func openBoard(_ name: String, from current: String, in app: XCUIApplication) {
        let switcher = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", current)).firstMatch
        XCTAssertTrue(switcher.waitForExistence(timeout: 5))
        switcher.tap()
        let option = app.buttons[name]
        XCTAssertTrue(option.waitForExistence(timeout: 5))
        option.tap()
    }

    private func attach(_ app: XCUIApplication, name: String) {
        let screenshot = app.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)

        let data = screenshot.pngRepresentation
        let path = "/tmp/taskify_screens/\(name).png"
        try? data.write(to: URL(fileURLWithPath: path))
    }
}
