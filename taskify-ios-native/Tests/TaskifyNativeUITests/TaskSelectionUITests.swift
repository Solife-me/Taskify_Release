import XCTest

/// Runtime verification for Boards multi-select and its bulk actions.
final class TaskSelectionUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testBoardSharingCanSelectContactsPastTheFirstSix() {
        let app = launchWithListBoard(sharingFixture: true)
        app.buttons["board-share"].tap()
        let chooseContact = app.buttons["board-share-choose-contact"]
        for _ in 0..<5 where !chooseContact.isHittable { app.swipeUp() }
        XCTAssertTrue(chooseContact.isHittable)
        chooseContact.tap()

        let ninthContact = app.buttons["Contact 9"]
        for _ in 0..<5 where !ninthContact.isHittable { app.swipeUp() }
        XCTAssertTrue(ninthContact.isHittable, "The unfiltered picker must include contacts past the first six")
        ninthContact.tap()
        XCTAssertTrue(chooseContact.waitForExistence(timeout: 5))
        XCTAssertEqual(chooseContact.value as? String, "Contact 9")
        XCTAssertTrue(app.buttons["Send"].isEnabled)
    }

    func testBoardSharingCanSelectAGroupChat() {
        let app = launchWithListBoard(sharingFixture: true)
        app.buttons["board-share"].tap()
        let chooseRecipient = app.buttons["board-share-choose-contact"]
        for _ in 0..<5 where !chooseRecipient.isHittable { app.swipeUp() }
        XCTAssertTrue(chooseRecipient.isHittable)
        chooseRecipient.tap()

        let group = app.buttons["Project Crew"]
        XCTAssertTrue(group.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Group chats"].exists)
        group.tap()

        XCTAssertTrue(chooseRecipient.waitForExistence(timeout: 5))
        XCTAssertEqual(chooseRecipient.value as? String, "Project Crew")
        XCTAssertTrue(app.buttons["Send"].isEnabled)
    }

    func testSharedTaskShowsOriginalCreatorInCardAndEditor() {
        let app = launchWithListBoard(sharingFixture: true)
        let task = app.buttons["Edit Shopping item"]
        XCTAssertTrue(task.waitForExistence(timeout: 5))
        XCTAssertEqual(task.value as? String, "Created by Public name 9")
        XCTAssertFalse((app.buttons["Edit Move me"].value as? String ?? "").contains("Created by"))
        attach(app, name: "board-task-creator-card")
        task.tap()
        let creator = app.descendants(matching: .any)["task-editor-creator"].firstMatch
        XCTAssertTrue(creator.waitForExistence(timeout: 5))
        XCTAssertTrue(creator.label.contains("Created by") || creator.staticTexts["Created by"].exists)
        XCTAssertTrue(
            creator.label.contains("Public name 9")
                || creator.value as? String == "Public name 9"
                || creator.staticTexts["Public name 9"].exists
        )
        attach(app, name: "board-task-creator-editor")
    }

    func testDraggingSelectedTasksReordersThemTogether() throws {
        let app = launchWithListBoard()
        let quickAdd = app.textFields.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "New task in")).firstMatch
        XCTAssertTrue(quickAdd.waitForExistence(timeout: 5))
        quickAdd.tap()
        quickAdd.typeText("Drag test A\n")
        quickAdd.typeText("Drag test B\n")

        let titles = ["Move me", "Drag test A", "Drag test B"]
        for title in titles {
            XCTAssertTrue(app.buttons["Edit \(title)"].waitForExistence(timeout: 5))
        }
        try enterSelectionMode(app)
        let ordered = titles.sorted {
            app.buttons["Select \($0)"].frame.midY < app.buttons["Select \($1)"].frame.midY
        }
        app.buttons["Select \(ordered[0])"].tap()
        app.buttons["Select \(ordered[2])"].tap()
        XCTAssertTrue(app.staticTexts["2 selected"].waitForExistence(timeout: 5))

        app.buttons["Deselect \(ordered[2])"].press(
            forDuration: 0.8,
            thenDragTo: app.buttons["Select \(ordered[1])"]
        )

        XCTAssertTrue(app.staticTexts["2 selected"].waitForNonExistence(timeout: 5))
        let first = app.buttons["Edit \(ordered[0])"]
        let second = app.buttons["Edit \(ordered[2])"]
        let anchor = app.buttons["Edit \(ordered[1])"]
        XCTAssertTrue(first.exists && second.exists && anchor.exists)
        XCTAssertLessThan(first.frame.midY, second.frame.midY)
        XCTAssertLessThan(second.frame.midY, anchor.frame.midY)
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

    private func launchWithListBoard(sharingFixture: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_BOARD_FIXTURE"] = "1"
        app.launchEnvironment["TASKIFY_UI_TEST_LIST_BOARD"] = "1"
        if sharingFixture {
            app.launchEnvironment["TASKIFY_UI_TEST_BOARD_SHARING"] = "1"
        }
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
