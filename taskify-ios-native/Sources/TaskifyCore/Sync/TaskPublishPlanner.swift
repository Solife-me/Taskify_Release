import Foundation

/// A task version to publish: the task as stamped, its board, and the event timestamp.
public struct TaskPublishStamp: Sendable {
    public let board: Board
    public let task: TaskItem
    public let timestamp: Int
}

/// Decides which tasks to publish and makes that decision durable (C7-1).
///
/// Stamping a task gives it a new Nostr timestamp, records the fingerprint of what relays will
/// hold, and marks it `publishPending`. The caller saves the snapshot (with the marks) before
/// the slow work: encoding, encryption, signing and queueing. Only once an event is in the
/// durable outbox is its mark cleared (`markQueued`). A failure, or the app being closed in
/// between, leaves the mark, and `pendingTaskIDs` names those tasks for the next launch,
/// reconnect or retry, which re-stamps them even though their fingerprint already matches.
public enum TaskPublishPlanner {
    /// Stamps `taskIDs`. A task whose publishable state matches what relays last saw is skipped
    /// unless it is in `force` (still pending from an earlier attempt).
    public static func stamp(
        _ snapshot: inout TaskifySnapshot,
        taskIDs: [String],
        force: Set<String> = [],
        now: Int = Int(Date().timeIntervalSince1970)
    ) -> [TaskPublishStamp] {
        if let taskID = taskIDs.first, taskIDs.count == 1 {
            guard let index = snapshot.tasks.firstIndex(where: { $0.id == taskID }),
                  let board = snapshot.boards.first(where: { $0.id == snapshot.tasks[index].boardID }),
                  let stamp = stampTask(&snapshot.tasks[index], board: board,
                                        force: force.contains(taskID), now: now) else { return [] }
            return [stamp]
        }
        let indexByID = Dictionary(
            snapshot.tasks.indices.map { (snapshot.tasks[$0].id, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        let boardByID = Dictionary(snapshot.boards.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var stamps: [TaskPublishStamp] = []
        var seen = Set<String>()
        for taskID in taskIDs where seen.insert(taskID).inserted {
            guard let index = indexByID[taskID],
                  let board = boardByID[snapshot.tasks[index].boardID],
                  let stamp = stampTask(&snapshot.tasks[index], board: board,
                                        force: force.contains(taskID), now: now) else { continue }
            stamps.append(stamp)
        }
        return stamps
    }

    private static func stampTask(_ task: inout TaskItem, board: Board, force: Bool, now: Int) -> TaskPublishStamp? {
        let fingerprint = TaskEventCodec.publishFingerprint(task: task, board: board)
        if !force, let fingerprint, fingerprint == task.publishedFingerprint { return nil }
        let timestamp = NostrEvent.nextTimestamp(after: task.nostrUpdatedAt, now: now)
        task.nostrUpdatedAt = timestamp
        task.publishedFingerprint = fingerprint
        task.publishPending = true
        return TaskPublishStamp(board: board, task: task, timestamp: timestamp)
    }

    /// Signs the initial durable versions without waiting on relay discovery or mining.
    /// The sync engine handles proof of work independently for each relay.
    public static func publishRequests(
        stamps: [TaskPublishStamp],
        boardPublishes: [(board: Board, timestamp: Int)]
    ) throws -> [TaskSyncPublishRequest] {
        let boards = try boardPublishes.map { publish in
            let event = try TaskEventCodec.boardEvent(board: publish.board, createdAt: publish.timestamp)
            return TaskSyncPublishRequest(event: event, board: publish.board, taskID: "_board")
        }
        let tasks = try stamps.map { stamp in
            let event = try TaskEventCodec.taskEvent(task: stamp.task, board: stamp.board, createdAt: stamp.timestamp)
            return TaskSyncPublishRequest(event: event, board: stamp.board, taskID: stamp.task.id)
        }
        return boards + tasks
    }

    /// The stamped versions are in the durable outbox. A task stamped again since keeps its mark.
    /// `events` (task id -> queued event) records each version's id, which decides a same-second
    /// tie with another device's version (`EventVersion`, C7-3).
    public static func markQueued(
        _ snapshot: inout TaskifySnapshot,
        stamps: [TaskPublishStamp],
        events: [String: NostrEvent] = [:]
    ) {
        guard !stamps.isEmpty else { return }
        let timestampByID = Dictionary(stamps.map { ($0.task.id, $0.timestamp) }, uniquingKeysWith: { _, last in last })
        for index in snapshot.tasks.indices {
            guard let timestamp = timestampByID[snapshot.tasks[index].id],
                  snapshot.tasks[index].publishPending == true,
                  snapshot.tasks[index].nostrUpdatedAt == timestamp else { continue }
            snapshot.tasks[index].publishPending = nil
        }
        recordQueuedEvents(&snapshot, events: events)
    }

    /// Records the ids of task events this device queued, for tasks still at that version.
    public static func recordQueuedEvents(_ snapshot: inout TaskifySnapshot, events: [String: NostrEvent]) {
        guard !events.isEmpty else { return }
        for index in snapshot.tasks.indices {
            guard let event = events[snapshot.tasks[index].id],
                  snapshot.tasks[index].nostrUpdatedAt == event.createdAt else { continue }
            snapshot.tasks[index].nostrEventVersion = EventVersion(event)
        }
    }

    /// Tasks stamped but never queued: publish these again.
    public static func pendingTaskIDs(in snapshot: TaskifySnapshot) -> [String] {
        snapshot.tasks.filter { $0.publishPending == true }.map(\.id)
    }
}
