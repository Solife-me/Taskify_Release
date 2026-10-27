import XCTest
@testable import TaskifyCore

/// C7-4: a Scripture Memory review that lost its passage link is linked again, as on the PWA.
final class ScriptureRelinkTests: XCTestCase {
    private let john = ScriptureMemoryEntry(id: "e1", bookID: "JHN", chapter: 3, startVerse: 16, endVerse: 16, addedAtISO: "2026-09-01T00:00:00Z", stage: 2)
    private let genesis = ScriptureMemoryEntry(id: "e2", bookID: "GEN", chapter: 1, startVerse: 1, endVerse: 1, addedAtISO: "2026-09-01T00:00:00Z")

    private func orphan(title: String? = nil) -> TaskItem {
        var task = TaskItem(id: "r", boardID: "b", title: title ?? "Review \(ScriptureMemoryAlgorithm.reference(for: john))")
        task.seriesID = ScriptureMemoryAlgorithm.seriesID
        return task
    }

    func testAnOrphanedOpenReviewIsLinkedToThePassageItsTitleNames() {
        XCTAssertEqual(ScriptureMemoryAlgorithm.passageToRelink(orphan(), entries: [john, genesis])?.id, "e1")
    }

    func testLinkedCompletedAndAmbiguousReviewsAreLeftAlone() {
        var linked = orphan()
        linked.scriptureMemoryID = "e2"
        var done = orphan()
        done.completed = true
        XCTAssertNil(ScriptureMemoryAlgorithm.passageToRelink(linked, entries: [john]))
        XCTAssertNil(ScriptureMemoryAlgorithm.passageToRelink(done, entries: [john]))
        XCTAssertNil(ScriptureMemoryAlgorithm.passageToRelink(orphan(title: "Review Romans 8:28"), entries: [john]))
        XCTAssertNil(ScriptureMemoryAlgorithm.passageToRelink(orphan(), entries: [john, john]), "two matches: no guess")
        var ordinary = orphan()
        ordinary.seriesID = nil
        XCTAssertNil(ScriptureMemoryAlgorithm.passageToRelink(ordinary, entries: [john]))
    }
}
