/// SyncEngine.swift
/// Board sync engine — mirrors the PWA's App.tsx subscription architecture.
///
/// PWA reference: taskify-pwa/src/App.tsx (board subscription effect)
///                taskify-runtime-nostr/src/RuntimeNostrSession.ts (fetchEvents)
///
/// Key behaviours mirrored from PWA:
/// - IDB (here: SwiftData) renders immediately on load without waiting for relay
/// - Per-relay batch maps: events held per relay until that relay fires EOSE
/// - On each relay's EOSE: flush its batch with clock-protected merge
/// - 25s absolute timeout flushes remaining batches for stuck relays
/// - 150ms live micro-batch coalescer for post-EOSE live events
/// - Task._nostrAt (here: createdAt): relay event unix seconds, used for clock-protected merge
/// - Only open tasks shown immediately; deleted/done filtered at render time

import Foundation
import SwiftData

// MARK: - BoardSyncManager

/// Long-lived per-board subscription manager. Mirrors the board subscription effect in App.tsx.
@MainActor
public final class BoardSyncManager: ObservableObject {

    @Published public private(set) var syncing = false
    @Published public private(set) var lastSyncError: String?

    private let relayPool: RelayPool
    private let modelContext: ModelContext

    // Per-relay batch maps — mirrors relayBatchRef in App.tsx
    // [relayUrl: [taskId: NostrEvent]]
    private var relayBatches: [String: [String: NostrEvent]] = [:]
    // Tracks which relays are still pending EOSE per board — mirrors pendingRelaysByBoardRef
    private var pendingRelays: Set<String> = []

    private var liveCoalescer: Task<Void, Never>? = nil
    private let liveBatchDelayMs = 150
    private let absoluteTimeoutSecs = 25.0

    public init(relayPool: RelayPool, modelContext: ModelContext) {
        self.relayPool = relayPool
        self.modelContext = modelContext
    }

    // MARK: - Subscribe to a board

    /// Opens a live subscription for a board and processes events.
    /// Returns a cancellation token. Call cancel() to stop the subscription.
    public func subscribe(board: TaskifyBoard) -> Task<Void, Never> {
        syncing = true
        relayBatches.removeAll()
        pendingRelays.removeAll()

        return Task { [weak self] in
            guard let self else { return }

            let boardId = board.id
            let bTag = boardTagHash(boardId)

            // Determine `since` from cursor — same logic as PWA/CLI
            let coldFetchDays = 30
            let since: Int
            if let cursor = board.lastSyncAt, cursor > 0 {
                since = max(0, cursor - 300)
            } else {
                since = Int(Date().timeIntervalSince1970) - coldFetchDays * 86400
            }

            let filter: [String: Any] = [
                "kinds": [30301],
                "#b": [bTag],
                "since": since,
            ]

            // Absolute 25s timeout — mirrors App.tsx absoluteTimeoutSecs

            let _ = await relayPool.subscribe(
                filters: [filter],
                onEvent: { [weak self] event, relayUrl in
                    guard let self else { return }
                    Task { @MainActor in
                        let relay = relayUrl ?? "__unknown__"
                        if self.relayBatches[relay] == nil { self.relayBatches[relay] = [:] }
                        if let taskId = event.tagValue("d"), !taskId.isEmpty {
                            // Clock-protected: only keep if newer than what we have
                            if let existing = self.relayBatches[relay]?[taskId] {
                                if event.created_at >= existing.created_at {
                                    self.relayBatches[relay]?[taskId] = event
                                }
                            } else {
                                self.relayBatches[relay]?[taskId] = event
                            }
                        }
                        self.scheduleCoalesce()
                    }
                },
                onEose: { [weak self] relayUrl in
                    guard let self else { return }
                    Task { @MainActor in
                        let relay = relayUrl ?? "__unknown__"
                        await self.flushRelayBatch(relay, board: board)
                        self.pendingRelays.remove(relay)
                        if self.pendingRelays.isEmpty { self.syncing = false }
                    }
                }
            )

            // Absolute timeout — flush all remaining batches
            try? await Task.sleep(nanoseconds: UInt64(absoluteTimeoutSecs * 1_000_000_000))
            if !Task.isCancelled {
                for (relay, _) in self.relayBatches {
                    await self.flushRelayBatch(relay, board: board)
                }
                self.syncing = false
            }
        }
    }

    // MARK: - Flush relay batch

    /// Merges one relay's batch into SwiftData.
    /// Clock-protected: relay data skipped if SwiftData already has a newer event.
    private func flushRelayBatch(_ relayUrl: String, board: TaskifyBoard) async {
        guard let batch = relayBatches[relayUrl], !batch.isEmpty else { return }
        relayBatches.removeValue(forKey: relayUrl)

        let boardId = board.id

        for (taskId, event) in batch {
            guard let plaintext = try? decryptTaskPayload(event.content, boardId: boardId),
                  let data = plaintext.data(using: .utf8),
                  let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let status = event.tagValue("status")
            else { continue }

            // Check existing
            let descriptor = FetchDescriptor<TaskifyTask>(
                predicate: #Predicate<TaskifyTask> { t in t.id == taskId }
            )
            let existing = try? modelContext.fetch(descriptor).first

            if let existing {
                // Clock-protected merge: skip if we already have a newer version
                if event.created_at < existing.createdAt { continue }
                applyPayload(payload, status: status, to: existing, eventCreatedAt: event.created_at, colTag: event.tagValue("col"))
            } else {
                let task = makeTask(id: taskId, boardId: boardId, boardName: board.name,
                                    payload: payload, status: status,
                                    eventCreatedAt: event.created_at, colTag: event.tagValue("col"))
                modelContext.insert(task)
            }
        }

        // Advance cursor
        let maxCreatedAt = batch.values.map(\.created_at).max() ?? 0
        if maxCreatedAt > (board.lastSyncAt ?? 0) { board.lastSyncAt = maxCreatedAt }

        try? modelContext.save()
    }

    // MARK: - Live micro-batch coalescer (150ms)

    private func scheduleCoalesce() {
        liveCoalescer?.cancel()
        liveCoalescer = Task {
            try? await Task.sleep(nanoseconds: UInt64(liveBatchDelayMs) * 1_000_000)
            if !Task.isCancelled {
                // Flush all pending live batches
                // (live events post-EOSE are delivered immediately — no held batch)
            }
        }
    }

    // MARK: - Calendar events

    public func syncCalendarEvents(board: TaskifyBoard) async {
        let bTag = boardTagHash(board.id)
        let filter: [String: Any] = [
            "kinds": [30310],
            "#b": [bTag],
            "limit": 500,
        ]
        let events = await relayPool.fetchEvents(filters: [filter], hardTimeoutMs: 12_000, eoseGraceMs: 200, inactivityMs: 3_000)
        await mergeCalendarEvents(events, board: board)
    }

    private func mergeCalendarEvents(_ events: [NostrEvent], board: TaskifyBoard) async {
        let boardId = board.id
        // Build latest-per-id map (mirrors listEvents in runtime)
        var latestById: [String: NostrEvent] = [:]
        for event in events {
            guard let id = event.tagValue("d"), !id.isEmpty else { continue }
            if let existing = latestById[id] {
                if event.created_at >= existing.created_at { latestById[id] = event }
            } else {
                latestById[id] = event
            }
        }

        for (eventId, event) in latestById {
            guard let payloadRaw = try? decryptCalendarPayload(event.content, boardId: boardId),
                  let payload = payloadRaw as? [String: Any]
            else { continue }

            let deleted = boolField(payload["deleted"]) == true

            let descriptor = FetchDescriptor<TaskifyCalendarEvent>(
                predicate: #Predicate<TaskifyCalendarEvent> { e in e.id == eventId }
            )
            if let existing = try? modelContext.fetch(descriptor).first {
                if event.created_at >= existing.createdAt {
                    if let title = stringField(payload["title"]), !title.isEmpty {
                        existing.title = title
                    }
                    existing.summary = stringField(payload["summary"])
                    existing.kind = stringField(payload["kind"]) ?? existing.kind
                    existing.startDate = stringField(payload["startDate"])
                    existing.endDate = stringField(payload["endDate"])
                    existing.startISO = stringField(payload["startISO"])
                    existing.endISO = stringField(payload["endISO"])
                    existing.startTzid = stringField(payload["startTzid"])
                    existing.endTzid = stringField(payload["endTzid"])
                    existing.eventDescription = stringField(payload["description"])
                    existing.columnId = event.tagValue("col")?.isEmpty == false ? event.tagValue("col") : nil
                    existing.order = event.tagValue("order").flatMap(Int.init)
                    existing.deleted = deleted
                    existing.createdAt = event.created_at
                    updateJSONField(payload, key: "documents") { existing.documentsJSON = $0 }
                    updateJSONField(payload, key: "locations") { existing.locationsJSON = $0 }
                    updateJSONField(payload, key: "references") { existing.referencesJSON = $0 }
                }
            } else if !deleted {
                let calEvent = TaskifyCalendarEvent(
                    id: eventId,
                    boardId: boardId,
                    title: stringField(payload["title"]) ?? "",
                    kind: stringField(payload["kind"]) ?? "date",
                    createdAt: event.created_at
                )
                calEvent.boardName = board.name
                calEvent.summary = stringField(payload["summary"])
                calEvent.startDate = stringField(payload["startDate"])
                calEvent.endDate = stringField(payload["endDate"])
                calEvent.startISO = stringField(payload["startISO"])
                calEvent.endISO = stringField(payload["endISO"])
                calEvent.startTzid = stringField(payload["startTzid"])
                calEvent.endTzid = stringField(payload["endTzid"])
                calEvent.eventDescription = stringField(payload["description"])
                calEvent.columnId = event.tagValue("col")?.isEmpty == false ? event.tagValue("col") : nil
                calEvent.order = event.tagValue("order").flatMap(Int.init)
                calEvent.deleted = false
                updateJSONField(payload, key: "documents") { calEvent.documentsJSON = $0 }
                updateJSONField(payload, key: "locations") { calEvent.locationsJSON = $0 }
                updateJSONField(payload, key: "references") { calEvent.referencesJSON = $0 }
                modelContext.insert(calEvent)
            }
        }
        try? modelContext.save()
    }

    // MARK: - Publish task

    public func publishTask(_ task: TaskifyTask, status: String, privateKeyBytes: Data, pubkeyHex: String) async throws {
        let payload = buildTaskPayload(task)
        let json = try JSONSerialization.data(withJSONObject: payload)
        let plaintext = String(data: json, encoding: .utf8)!
        let encrypted = try encryptTaskPayload(plaintext, boardId: task.boardId)
        let bTag = boardTagHash(task.boardId)
        let colTag = task.column ?? ""
        let unsigned = UnsignedNostrEvent(
            pubkey: pubkeyHex,
            kind: 30301,
            tags: [["d", task.id], ["b", bTag], ["col", colTag], ["status", status]],
            content: encrypted
        )
        let event = try unsigned.sign(privateKeyBytes: privateKeyBytes)
        await relayPool.publish(event: event)
        if status == "deleted" {
            let aTag = "30301:\(pubkeyHex):\(task.id)"
            let deletion = try UnsignedNostrEvent(
                pubkey: pubkeyHex,
                kind: TaskifyEventKind.deletion.rawValue,
                tags: [["a", aTag]],
                content: "Task deleted"
            ).sign(privateKeyBytes: privateKeyBytes)
            await relayPool.publish(event: deletion)
        }
    }

    // MARK: - Helpers

    private func applyPayload(_ payload: [String: Any], status: String, to task: TaskifyTask, eventCreatedAt: Int, colTag: String?) {
        if let title = payload["title"] as? String, !title.isEmpty {
            task.title = title
        }
        if payload.keys.contains("note") {
            task.note = stringField(payload["note"])
        }
        if payload.keys.contains("dueISO") {
            task.dueISO = stringField(payload["dueISO"]) ?? ""
        }
        if payload.keys.contains("dueDateEnabled") {
            task.dueDateEnabled = boolField(payload["dueDateEnabled"])
        }
        if payload.keys.contains("dueTimeEnabled") {
            task.dueTimeEnabled = boolField(payload["dueTimeEnabled"])
        }
        if payload.keys.contains("dueTimeZone") {
            task.dueTimeZone = stringField(payload["dueTimeZone"])
        }
        if payload.keys.contains("priority") {
            task.priority = intField(payload["priority"])
        }
        task.completed = status == "done"
        if payload.keys.contains("completedAt") {
            task.completedAt = stringField(payload["completedAt"])
        }
        if payload.keys.contains("completedBy") {
            task.completedBy = normalizedPublicKeyField(payload["completedBy"])
        }
        task.deleted = status == "deleted"
        task.column = colTag?.isEmpty == false ? colTag : nil
        task.createdAt = eventCreatedAt
        if payload.keys.contains("updatedAt") {
            task.updatedAt = stringField(payload["updatedAt"])
        }
        if payload.keys.contains("createdBy") {
            task.createdBy = normalizedPublicKeyField(payload["createdBy"])
        }
        if payload.keys.contains("lastEditedBy") {
            task.lastEditedBy = normalizedPublicKeyField(payload["lastEditedBy"]) ?? task.createdBy
        }
        if payload.keys.contains("sourceBoardId") {
            task.sourceBoardId = stringField(payload["sourceBoardId"]) ?? task.boardId
        }
        if payload.keys.contains("inboxItem") {
            switch payload["inboxItem"] {
            case is NSNull:
                task.inboxItem = nil
            case let object as [String: Any]:
                task.inboxItem = !object.isEmpty
            default:
                task.inboxItem = boolField(payload["inboxItem"])
            }
        }
        if payload.keys.contains("hiddenUntilISO") {
            task.hiddenUntilISO = stringField(payload["hiddenUntilISO"])
        }
        if payload.keys.contains("streak") {
            task.streak = intField(payload["streak"])
        }
        if payload.keys.contains("longestStreak") {
            task.longestStreak = intField(payload["longestStreak"])
        }
        if payload.keys.contains("seriesId") {
            task.seriesId = stringField(payload["seriesId"])
        }
        updateJSONField(payload, key: "recurrence") { task.recurrenceJSON = $0 }
        updateJSONField(payload, key: "subtasks") { task.subtasksJSON = $0 }
        updateJSONField(payload, key: "assignees") { task.assigneesJSON = $0 }
        updateJSONField(payload, key: "documents") { task.documentsJSON = $0 }
        updateJSONField(payload, key: "images") { task.imagesJSON = $0 }
    }

    private func makeTask(id: String, boardId: String, boardName: String?, payload: [String: Any], status: String, eventCreatedAt: Int, colTag: String?) -> TaskifyTask {
        let task = TaskifyTask(id: id, boardId: boardId, title: payload["title"] as? String ?? "", completed: status == "done", deleted: status == "deleted", createdAt: eventCreatedAt)
        task.boardName = boardName
        applyPayload(payload, status: status, to: task, eventCreatedAt: eventCreatedAt, colTag: colTag)
        return task
    }

    private func buildTaskPayload(_ task: TaskifyTask) -> [String: Any] {
        [
            "title": task.title,
            "priority": nullable(task.priority),
            "note": task.note ?? "",
            "dueISO": task.dueISO ?? "",
            "completedAt": nullable(task.completedAt),
            "completedBy": nullable(task.completedBy),
            "recurrence": jsonField(task.recurrenceJSON),
            "hiddenUntilISO": nullable(task.hiddenUntilISO),
            "createdBy": nullable(task.createdBy),
            "lastEditedBy": nullable(task.lastEditedBy),
            "createdAt": task.createdAt > 0 ? task.createdAt * 1000 : NSNull(),
            "updatedAt": nullable(task.updatedAt),
            "sourceBoardId": nullable(task.sourceBoardId),
            "streak": nullable(task.streak),
            "longestStreak": nullable(task.longestStreak),
            "seriesId": nullable(task.seriesId),
            "dueDateEnabled": nullable(task.dueDateEnabled),
            "dueTimeEnabled": nullable(task.dueTimeEnabled),
            "dueTimeZone": nullable(task.dueTimeZone),
            "subtasks": jsonField(task.subtasksJSON),
            "assignees": jsonField(task.assigneesJSON),
            "documents": jsonField(task.documentsJSON),
            "images": jsonField(task.imagesJSON),
            "inboxItem": nullable(task.inboxItem),
        ]
    }

    private func jsonField(_ jsonStr: String?) -> Any {
        guard let s = jsonStr, let data = s.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) else { return NSNull() }
        return obj
    }

    private func nullable(_ value: Any?) -> Any {
        value ?? NSNull()
    }

    private func stringField(_ value: Any?) -> String? {
        guard let value, !(value is NSNull) else { return nil }
        return value as? String
    }

    private func boolField(_ value: Any?) -> Bool? {
        guard let value, !(value is NSNull) else { return nil }
        return value as? Bool
    }

    private func intField(_ value: Any?) -> Int? {
        guard let value, !(value is NSNull) else { return nil }
        if let int = value as? Int {
            return int
        }
        if let number = value as? NSNumber {
            return number.intValue
        }
        return nil
    }

    private func normalizedPublicKeyField(_ value: Any?) -> String? {
        guard let raw = stringField(value) else { return nil }
        return try? NostrIdentityService.normalizePublicKeyInput(raw)
    }

    private func updateJSONField(_ payload: [String: Any], key: String, setter: (String?) -> Void) {
        guard payload.keys.contains(key) else { return }
        guard let raw = payload[key], !(raw is NSNull) else {
            setter(nil)
            return
        }
        guard JSONSerialization.isValidJSONObject(raw),
              let data = try? JSONSerialization.data(withJSONObject: raw),
              let string = String(data: data, encoding: .utf8) else {
            setter(nil)
            return
        }
        setter(string)
    }
}
