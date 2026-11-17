import XCTest
@testable import TaskifyCore

/// C7-1: an edit is never lost between being made and being queued for the relays.
final class TaskPublishPlannerTests: XCTestCase {
    private func snapshot() -> TaskifySnapshot {
        var snapshot = TaskifySnapshot.empty
        let board = snapshot.boards[0]
        snapshot.tasks = [TaskItem(id: "t1", boardID: board.id, title: "Write report")]
        return snapshot
    }

    func testTaskAndBoardAreDurablyQueuedBeforeRelayNegotiation() async throws {
        var state = snapshot()
        let stamps = TaskPublishPlanner.stamp(&state, taskIDs: ["t1"], now: 1_000)
        let board = try XCTUnwrap(stamps.first?.board)
        let requests = try TaskPublishPlanner.publishRequests(
            stamps: stamps,
            boardPublishes: [(board, 1_001)]
        )
        XCTAssertEqual(requests.map(\.taskID), ["_board", "t1"])
        XCTAssertTrue(requests.allSatisfy { !$0.event.tags.contains { $0.first == "nonce" } })

        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let fileURL = directory.appendingPathComponent("outbox.json")
        let engine = TaskSyncEngine(outbox: NostrOutboxStore(fileURL: fileURL), networkingEnabled: false)
        try await engine.enqueueForPublish(requests)
        let restored = await NostrOutboxStore(fileURL: fileURL).allEntries()
        XCTAssertEqual(Set(restored.map(\.event.id)), Set(requests.map(\.event.id)))
        XCTAssertEqual(restored.first { $0.taskID == "t1" }?.event.createdAt, 1_000)
        await engine.stop()
    }

    func testAnEditInterruptedBeforeQueueingIsPublishedAfterRelaunch() throws {
        var saved = snapshot()
        saved.tasks[0].title = "Write the report"
        let first = TaskPublishPlanner.stamp(&saved, taskIDs: ["t1"], now: 1_000)
        XCTAssertEqual(first.count, 1)
        // The app is closed (or queueing fails) before the event reaches the outbox. What was
        // saved still marks the task as pending, although its fingerprint now matches.
        let data = try JSONEncoder().encode(saved)
        var relaunched = try JSONDecoder().decode(TaskifySnapshot.self, from: data)
        let pending = TaskPublishPlanner.pendingTaskIDs(in: relaunched)
        XCTAssertEqual(pending, ["t1"])
        XCTAssertTrue(TaskPublishPlanner.stamp(&relaunched, taskIDs: pending, now: 1_000).isEmpty,
                      "without force the matching fingerprint would skip it, which lost the edit")
        let retried = TaskPublishPlanner.stamp(&relaunched, taskIDs: pending, force: Set(pending), now: 1_000)
        XCTAssertEqual(retried.map(\.task.title), ["Write the report"])
        XCTAssertGreaterThan(retried[0].timestamp, first[0].timestamp)
    }

    func testQueueingClearsTheMarkUnlessTheTaskWasStampedAgain() {
        var state = snapshot()
        let first = TaskPublishPlanner.stamp(&state, taskIDs: ["t1"], now: 1_000)
        state.tasks[0].title = "Edited while the first publish was encoding"
        let second = TaskPublishPlanner.stamp(&state, taskIDs: ["t1"], now: 1_001)
        TaskPublishPlanner.markQueued(&state, stamps: first)
        XCTAssertEqual(TaskPublishPlanner.pendingTaskIDs(in: state), ["t1"], "the newer edit is still waiting")
        TaskPublishPlanner.markQueued(&state, stamps: second)
        XCTAssertEqual(TaskPublishPlanner.pendingTaskIDs(in: state), [])
    }

    func testAnUnchangedTaskIsNotPublishedAgain() {
        var state = snapshot()
        let stamps = TaskPublishPlanner.stamp(&state, taskIDs: ["t1"], now: 1_000)
        TaskPublishPlanner.markQueued(&state, stamps: stamps)
        XCTAssertTrue(TaskPublishPlanner.stamp(&state, taskIDs: ["t1"], now: 1_001).isEmpty)
    }
}
