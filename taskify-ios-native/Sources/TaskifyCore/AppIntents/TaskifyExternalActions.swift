import Foundation

/// The user's task settings, as the app last saw them, for processes that edit tasks without the
/// app: the widget, Siri and Shortcuts. The app writes them to the App Group whenever they change
/// (C10-1), so an edit made outside the app counts streaks, starts weeks and places new tasks the
/// way the same edit in the app would.
public struct TaskifyDeviceTaskSettings: Codable, Equatable, Sendable {
    public var streaksEnabled: Bool
    public var weekStart: WeekdayColumn
    public var newTaskPosition: NewTaskPosition
    /// The signed-in account, recorded as the task's last editor.
    public var editorPublicKey: String?

    /// The app's defaults: streaks on, weeks starting on Sunday, new tasks at the top.
    public init(
        streaksEnabled: Bool = true,
        weekStart: WeekdayColumn = .sunday,
        newTaskPosition: NewTaskPosition = .top,
        editorPublicKey: String? = nil
    ) {
        self.streaksEnabled = streaksEnabled
        self.weekStart = weekStart
        self.newTaskPosition = newTaskPosition
        self.editorPublicKey = editorPublicKey
    }

    private static let key = "taskify.deviceTaskSettings.v1"

    /// Nil where the App Group isn't in effect (an unentitled Mac): there is nothing to share with.
    public static var sharedDefaults: UserDefaults? {
        guard TaskifySharedContainer.isAvailable() else { return nil }
        return UserDefaults(suiteName: TaskifySharedContainer.appGroupID)
    }

    public static func load(from defaults: UserDefaults? = sharedDefaults) -> TaskifyDeviceTaskSettings {
        guard let data = defaults?.data(forKey: key),
              let settings = try? JSONDecoder().decode(TaskifyDeviceTaskSettings.self, from: data) else {
            return TaskifyDeviceTaskSettings()
        }
        return settings
    }

    public static func update(
        in defaults: UserDefaults? = sharedDefaults,
        _ change: (inout TaskifyDeviceTaskSettings) -> Void
    ) {
        guard let defaults else { return }
        var settings = load(from: defaults)
        let before = settings
        change(&settings)
        guard settings != before, let data = try? JSONEncoder().encode(settings) else { return }
        defaults.set(data, forKey: key)
    }
}

/// Task edits made outside the app (C10-1). They go through the same snapshot operations as the
/// app, with the user's settings, so the result matches the app's. The app reads them in from
/// the store later and publishes them.
public enum TaskifyExternalActions {
    /// Marks a task complete or incomplete. Does nothing when it already is: a widget drawn
    /// before the task was completed elsewhere must not reopen it. Returns whether it changed.
    @discardableResult
    public static func setCompleted(
        _ completed: Bool,
        taskID: String,
        in snapshot: inout TaskifySnapshot,
        settings: TaskifyDeviceTaskSettings,
        now: Date = Date()
    ) -> Bool {
        guard let task = snapshot.tasks.first(where: { $0.id == taskID && !$0.isDeleted }),
              task.completed != completed else { return false }
        return snapshot.toggleCompletion(
            taskID: taskID,
            editorPublicKey: settings.editorPublicKey,
            streaksEnabled: settings.streaksEnabled,
            weekStartsOn: settings.weekStart,
            now: now
        )
    }

    /// Loads the tasks, completes one, saves and publishes (`commit`). Returns whether anything
    /// changed.
    @discardableResult
    public static func completeTask(
        _ taskID: String,
        store: JSONTaskStore = JSONTaskStore(),
        settings: TaskifyDeviceTaskSettings = .load(),
        publisher: TaskifyExternalPublisher = TaskifyExternalPublisher(),
        now: Date = Date()
    ) async throws -> Bool {
        var snapshot = try await store.load(areas: [.tasks])
        let before = Set(snapshot.tasks.lazy.filter { !$0.isDeleted }.map(\.id))
        guard setCompleted(true, taskID: taskID, in: &snapshot, settings: settings, now: now) else {
            return false
        }
        // The task, and the next occurrence its completion created.
        let changed = [taskID] + snapshot.tasks.filter { !$0.isDeleted && !before.contains($0.id) }.map(\.id)
        try await commit(snapshot, changedTaskIDs: changed, store: store, publisher: publisher)
        return true
    }

    /// Saves an edit made outside the app and sends it to the relays at once (C10-4).
    ///
    /// The changed tasks are stamped for publishing (`TaskPublishPlanner`) and saved with their
    /// pending marks before any network work, so the store is the durable record. The publisher
    /// then tries the boards' relays for a few seconds. A task whose event every relay accepted
    /// loses its mark; any other keeps it, and the app publishes it when it next runs, as it does
    /// for its own interrupted publishes. `snapshot` must come from `store.load`.
    public static func commit(
        _ snapshot: TaskifySnapshot,
        changedTaskIDs: [String],
        store: JSONTaskStore,
        publisher: TaskifyExternalPublisher = TaskifyExternalPublisher(),
        now: Int = Int(Date().timeIntervalSince1970)
    ) async throws {
        var snapshot = snapshot
        let stamps = TaskPublishPlanner.stamp(&snapshot, taskIDs: changedTaskIDs, now: now)
        try await store.save(snapshot)
        guard !stamps.isEmpty else { return }

        let sent = await publisher.publish(stamps)
        guard !sent.isEmpty else { return }
        // Read again: the app may have saved while the relays answered. Only the stamped
        // versions are marked, so its newer edits are kept.
        var current = try await store.load(areas: [.tasks])
        TaskPublishPlanner.markQueued(
            &current,
            stamps: stamps.filter { sent[$0.task.id] != nil },
            events: sent
        )
        try await store.save(current)
    }
}

/// Sends task events from outside the app (C10-4), within a short time limit.
public struct TaskifyExternalPublisher: Sendable {
    /// Sends `event` to `relay`; true when the relay accepted it.
    public typealias Send = @Sendable (_ event: NostrEvent, _ relay: String) async -> Bool
    /// Signs a stamped task's event, with any proof of work its relays ask for.
    public typealias Prepare = @Sendable (_ stamp: TaskPublishStamp) async throws -> NostrEvent

    private let send: Send
    private let prepare: Prepare
    private let timeLimit: Duration

    public init(timeLimit: Duration = .seconds(6), prepare: Prepare? = nil, send: Send? = nil) {
        self.timeLimit = timeLimit
        self.prepare = prepare ?? { stamp in
            try await TaskEventCodec.prepareTaskEvent(task: stamp.task, board: stamp.board, createdAt: stamp.timestamp)
        }
        self.send = send ?? Self.sendToRelay
    }

    /// Never sends: the edit waits in the store for the app.
    public static let disabled = TaskifyExternalPublisher(timeLimit: .zero) { _, _ in false }

    /// Task id -> the event every one of its board's relays accepted within the time limit.
    public func publish(_ stamps: [TaskPublishStamp]) async -> [String: NostrEvent] {
        guard timeLimit > .zero else { return [:] }
        let send = send, prepare = prepare
        let sent = SentEvents()
        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                await withTaskGroup(of: Void.self) { tasks in
                    for stamp in stamps {
                        tasks.addTask {
                            guard let event = try? await prepare(stamp) else { return }
                            let relays = stamp.board.syncRelayURLs
                            let accepted = await withTaskGroup(of: Bool.self) { sends in
                                for relay in relays { sends.addTask { await send(event, relay) } }
                                var all = !relays.isEmpty
                                for await ok in sends { all = all && ok }
                                return all
                            }
                            // An answer after the time limit is not trusted: the app sends it again.
                            if accepted, !Task.isCancelled { await sent.add(event, for: stamp.task.id) }
                        }
                    }
                }
            }
            let timeLimit = timeLimit
            group.addTask { try? await Task.sleep(for: timeLimit) }
            // Whichever finishes first: every send, or the time limit.
            await group.next()
            group.cancelAll()
        }
        return await sent.events
    }

    private actor SentEvents {
        private(set) var events: [String: NostrEvent] = [:]
        func add(_ event: NostrEvent, for taskID: String) { events[taskID] = event }
    }

    /// One connection per relay; a duplicate counts as accepted. A relay that asks for
    /// authentication is left to the app, which signs in with the account key.
    @Sendable
    static func sendToRelay(_ event: NostrEvent, relay: String) async -> Bool {
        let connection = NostrRelayConnection(relayURL: relay, automaticallyAuthenticate: false)
        defer { Task { await connection.disconnect() } }
        do {
            try await connection.connect()
            try await connection.publish(event)
            for await message in connection.messages() {
                if Task.isCancelled { return false }
                switch message {
                case .acknowledgement(let id, let accepted, let message) where id == event.id:
                    return accepted || message.lowercased().hasPrefix("duplicate:")
                case .disconnected:
                    return false
                default:
                    continue
                }
            }
        } catch {}
        return false
    }
}
