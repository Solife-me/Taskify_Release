import XCTest
@testable import TaskifyCore

/// C7-3: two versions of a task with the same `created_at` resolve as relays do (NIP-01: the
/// lowest event id wins), so every device converges on the version relays keep.
final class TaskVersionTieTests: XCTestCase {
    private let low = String(repeating: "0a", count: 32)
    private let high = String(repeating: "f0", count: 32)

    private func snapshot(localTitle: String = "Local", at: Int = 100, eventID: String? = nil) -> TaskifySnapshot {
        var snapshot = TaskifySnapshot.empty
        var task = TaskItem(id: "t1", boardID: snapshot.boards[0].id, title: localTitle)
        task.nostrUpdatedAt = at
        snapshot.tasks = [task]
        return snapshot
    }

    private func remote(_ title: String) -> TaskItem {
        TaskItem(id: "t1", boardID: TaskifySnapshot.empty.boards[0].id, title: title)
    }

    func testASameSecondVersionReplacesOneWhoseIDIsUnknown() {
        var state = snapshot()
        XCTAssertTrue(state.mergeRemoteTask(remote("Remote"), eventCreatedAt: 100, eventID: high))
        XCTAssertEqual(state.tasks[0].title, "Remote", "relays keep a version with a known id; so must iOS")
        XCTAssertEqual(state.tasks[0].localEventVersion, EventVersion(createdAt: 100, id: high))
    }

    func testTheLowerIDWinsASameSecondTie() {
        var state = snapshot()
        state.tasks[0].nostrEventVersion = EventVersion(createdAt: 100, id: high)
        XCTAssertTrue(state.mergeRemoteTask(remote("Remote"), eventCreatedAt: 100, eventID: low))
        XCTAssertEqual(state.tasks[0].title, "Remote")

        var other = snapshot()
        other.tasks[0].nostrEventVersion = EventVersion(createdAt: 100, id: low)
        XCTAssertFalse(other.mergeRemoteTask(remote("Remote"), eventCreatedAt: 100, eventID: high))
        XCTAssertEqual(other.tasks[0].title, "Local", "relays keep the lower id, which is this device's")
    }

    func testAnOlderVersionNeverWinsWhateverItsID() {
        var state = snapshot()
        state.tasks[0].nostrEventVersion = EventVersion(createdAt: 100, id: high)
        XCTAssertFalse(state.mergeRemoteTask(remote("Remote"), eventCreatedAt: 99, eventID: low))
        XCTAssertEqual(state.tasks[0].title, "Local")
    }

    func testAnEditNotYetQueuedKeepsASameSecondTie() {
        var state = snapshot()
        state.tasks[0].title = "Edited"
        let stamps = TaskPublishPlanner.stamp(&state, taskIDs: ["t1"], now: 100)
        let at = stamps[0].timestamp
        XCTAssertFalse(state.mergeRemoteTask(remote("Remote"), eventCreatedAt: at, eventID: low))
        XCTAssertEqual(state.tasks[0].title, "Edited", "its id is unknown until it is signed and queued")
    }

    func testQueueingRecordsTheEventIDAndAReStampForgetsIt() throws {
        var state = snapshot()
        state.tasks[0].title = "Edited"
        let stamps = TaskPublishPlanner.stamp(&state, taskIDs: ["t1"], now: 200)
        let event = try TaskEventCodec.taskEvent(task: stamps[0].task, board: stamps[0].board, createdAt: stamps[0].timestamp)
        TaskPublishPlanner.markQueued(&state, stamps: stamps, events: ["t1": event])
        XCTAssertEqual(state.tasks[0].localEventVersion, EventVersion(event))

        state.tasks[0].nostrUpdatedAt = stamps[0].timestamp + 1
        XCTAssertNil(state.tasks[0].localEventVersion.id, "the id belongs to the earlier version")
    }

    func testTheSameContentAtTheSameSecondOnlyTeachesTheID() throws {
        var state = TaskifySnapshot.empty
        let board = state.boards[0]
        var task = TaskItem(id: "t1", boardID: board.id, title: "Mine")
        task.nostrUpdatedAt = 300
        task.order = 7
        task.publishedFingerprint = TaskEventCodec.publishFingerprint(task: task, board: board)
        state.tasks = [task]
        var echo = task
        echo.order = 0
        XCTAssertTrue(state.mergeRemoteTask(echo, eventCreatedAt: 300, eventID: low))
        XCTAssertEqual(state.tasks[0].order, 7, "nothing replaced")
        XCTAssertEqual(state.tasks[0].localEventVersion, EventVersion(createdAt: 300, id: low))
    }

    func testAStartupBatchKeepsTheVersionRelaysKeep() {
        var batch = TaskRelayStartupBatch()
        batch.insert(TaskRelayRecord(task: remote("High"), eventCreatedAt: 100, eventID: high))
        batch.insert(TaskRelayRecord(task: remote("Low"), eventCreatedAt: 100, eventID: low))
        batch.insert(TaskRelayRecord(task: remote("High again"), eventCreatedAt: 100, eventID: high))
        XCTAssertEqual(batch.drain().map(\.task.title), ["Low"])
    }
}
