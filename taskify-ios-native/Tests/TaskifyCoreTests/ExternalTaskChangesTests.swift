import Foundation
import XCTest
@testable import TaskifyCore

final class ExternalTaskChangesTests: XCTestCase {
    /// Fixed timestamps, so two calls describe the same task.
    private func task(_ id: String, title: String = "Task", completed: Bool = false) -> TaskItem {
        var item = TaskItem(id: id, boardID: "board", title: title)
        item.createdAt = Date(timeIntervalSince1970: 1_700_000_000)
        item.completed = completed
        return item
    }

    func testWidgetCompletionIsAppliedAndReported() {
        let base = [task("a"), task("b")]
        let theirs = [task("a", completed: true), task("b")]
        let merge = TaskifySnapshot.mergingExternalTaskChanges(base: base, ours: base, theirs: theirs)
        XCTAssertEqual(merge.tasks, theirs)
        XCTAssertEqual(merge.changedTaskIDs, ["a"])
    }

    func testShortcutAddedTaskIsAppendedAndReported() {
        let base = [task("a")]
        let ours = [task("a"), task("app-new")]
        let theirs = [task("a"), task("siri")]
        let merge = TaskifySnapshot.mergingExternalTaskChanges(base: base, ours: ours, theirs: theirs)
        XCTAssertEqual(merge.tasks.map(\.id), ["a", "app-new", "siri"])
        XCTAssertEqual(merge.changedTaskIDs, ["siri"])
    }

    func testTheAppsOwnEditWinsWhenBothChangedATask() {
        let base = [task("a")]
        let ours = [task("a", title: "Renamed in the app")]
        let theirs = [task("a", completed: true)]
        let merge = TaskifySnapshot.mergingExternalTaskChanges(base: base, ours: ours, theirs: theirs)
        XCTAssertEqual(merge.tasks, ours)
        XCTAssertTrue(merge.changedTaskIDs.isEmpty)
    }

    func testNothingChangedOutside() {
        let base = [task("a")]
        let ours = [task("a", title: "Edited")]
        let merge = TaskifySnapshot.mergingExternalTaskChanges(base: base, ours: ours, theirs: base)
        XCTAssertEqual(merge.tasks, ours)
        XCTAssertTrue(merge.changedTaskIDs.isEmpty)
    }
}
