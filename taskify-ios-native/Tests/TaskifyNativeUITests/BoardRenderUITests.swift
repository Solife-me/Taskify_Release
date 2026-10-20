import XCTest

/// C8-1: board views follow only what they show. On the 140-task performance board, chat-state
/// changes must not re-render task cards, and editing one task re-renders about one card.
final class BoardRenderUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testChatChangesDoNotRenderCardsAndAnEditRendersFew() throws {
        let app = XCUIApplication()
        app.launchEnvironment["TASKIFY_UI_TEST_ONBOARDING"] = "skip"
        app.launchEnvironment["TASKIFY_UI_TEST_PERFORMANCE_FIXTURE"] = "1"
        app.launchEnvironment["TASKIFY_UI_TEST_PERF_PROBE"] = "1"
        app.launch()
        app.buttons["Boards"].tap()

        let probe = app.staticTexts["perf-probe"]
        XCTAssertTrue(probe.waitForExistence(timeout: 30))
        let values = Dictionary(uniqueKeysWithValues: probe.label.split(separator: " ").compactMap { part -> (String, Int)? in
            let pair = part.split(separator: "=")
            guard pair.count == 2, let value = Int(pair[1]) else { return nil }
            return (String(pair[0]), value)
        })
        print("[board render] \(probe.label)")
        let chat = try XCTUnwrap(values["chat"])
        let edit = try XCTUnwrap(values["edit"])
        XCTAssertEqual(chat, 0, "20 chat changes re-rendered \(chat) cards")
        XCTAssertLessThanOrEqual(edit, 3, "one task edit re-rendered \(edit) cards")
    }
}
