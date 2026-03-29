/// DataController.swift
/// Bridges RelayPool + BoardSyncManager + SwiftData ↔ ViewModels.
///
/// This is the missing wiring layer — the sync engine writes to SwiftData,
/// this controller reads from SwiftData and populates the view models,
/// and writes user edits back through the sync engine to Nostr relays.
///
/// Mirrors the data flow in App.tsx:
///   Nostr relay → decrypt → merge into local store → render
///   UI edit → update local store → encrypt → publish to relays

import CryptoKit
import Foundation
import SwiftData

// MARK: - BoardKeyDerivation (matches boardKeys.ts deriveBoardKeyPair)

/// Derives the deterministic secp256k1 keypair for a board.
/// This is the board's Nostr identity — tasks are published under this key.
public struct BoardKeyInfo {
    public let boardId: String
    public let privateKeyBytes: Data   // 32 bytes
    public let publicKeyHex: String    // 64-char hex (x-only)

    public init(boardId: String) throws {
        self.boardId = boardId
        let label = "taskify-board-nostr-key-v1"
        var material = Data(label.utf8)
        material.append(Data(boardId.utf8))
        let digest = SHA256.hash(data: material)
        self.privateKeyBytes = Data(digest)
        let xOnlyPub = try Secp256k1Helpers.xOnlyPublicKey(from: Data(digest))
        self.publicKeyHex = xOnlyPub.hexString
    }
}

// MARK: - DataController

@MainActor
public final class DataController: ObservableObject {

    // MARK: Published state

    @Published public private(set) var relayConnected: Int = 0
    @Published public private(set) var syncing: Bool = false
    @Published public private(set) var lastError: String?
    @Published public private(set) var activeBoardItems: [BoardTaskItem] = []
    @Published public private(set) var boardDefinitionsVersion: Int = 0
    @Published public private(set) var calendarEventsVersion: Int = 0
    @Published public private(set) var contactsVersion: Int = 0
    @Published public private(set) var publicFollowsVersion: Int = 0
    @Published public private(set) var contactNip05ChecksVersion: Int = 0
    @Published public private(set) var contactSyncState = ContactSyncState()
    @Published public private(set) var myProfileMetadata = TaskifyProfileMetadata()

    // MARK: Dependencies

    private var relayPool: RelayPool?
    private var modelContext: ModelContext?
    private var profile: TaskifyProfile?
    private var activeSubscriptionKeys: Set<String> = []
    private var activeBoardId: String?
    private var pendingBoardSyncIDs: Set<String> = []

    public init() {}

    // MARK: - Bootstrap

    /// Call after auth succeeds. Sets up the relay pool and SwiftData context.
    public func bootstrap(profile: TaskifyProfile, modelContext: ModelContext) async {
        self.profile = profile
        self.modelContext = modelContext
        myProfileMetadata = ContactPreferencesStore.loadProfileMetadata(npub: profile.npub)
        ensureStoredBoards(profile.boards)
        await rebuildRelayPool()
        await refreshAllBoardMetadata(boardIds: profile.boards.map(\.id))
    }

    /// Refresh relay connection count.
    public func refreshRelayStatus() async {
        guard let pool = relayPool else { return }
        relayConnected = await pool.connectedCount()
    }

    // MARK: - Board subscription

    /// Subscribe to a board's task events on all connected relays.
    /// Fetches tasks from SwiftData first (local-first), then syncs from relays.
    public func subscribeToBoard(_ boardId: String) async -> [BoardTaskItem] {
        await unsubscribe()
        activeBoardId = boardId
        syncing = true
        await refreshBoardMetadata(boardId: boardId)
        let sourceBoardIds = activeSourceBoardIds(for: boardId)
        await refreshAllBoardMetadata(boardIds: sourceBoardIds.filter { $0 != boardId })
        let localTasks = refreshActiveBoardItems()
        subscribeToBoardMetadata(boardIds: sourceBoardIds)
        subscribeToBoardTasks(boardId: boardId)
        return localTasks
    }

    /// Unsubscribe from the current board.
    public func unsubscribe() async {
        if let pool = relayPool {
            for key in activeSubscriptionKeys {
                await pool.unsubscribe(key: key)
            }
        }
        activeSubscriptionKeys.removeAll()
        activeBoardId = nil
        pendingBoardSyncIDs.removeAll()
        activeBoardItems = []
        syncing = false
    }

    // MARK: - Read from SwiftData

    /// Fetch all non-deleted tasks for a board from SwiftData.
    public func fetchTasksFromStore(boardId: String) -> [BoardTaskItem] {
        fetchTasksFromStore(boardIds: [boardId])
    }

    public func fetchTasksFromStore(boardIds: [String]) -> [BoardTaskItem] {
        guard let ctx = modelContext else { return [] }
        let descriptor = FetchDescriptor<TaskifyTask>(
            predicate: #Predicate<TaskifyTask> { t in
                t.deleted == false
            },
            sortBy: [SortDescriptor(\.createdAt, order: .reverse)]
        )
        guard let tasks = try? ctx.fetch(descriptor) else { return [] }
        let allowed = Set(boardIds)
        let boardNames = boardNamesById()
        return tasks
            .filter { allowed.contains($0.boardId) }
            .map { task in
                var item = BoardTaskItem.from(task)
                item.boardName = task.boardName ?? boardNames[task.boardId]
                return item
            }
    }

    /// Fetch all non-deleted tasks across all boards that have due dates.
    public func fetchUpcomingTasks(boardIds: [String]) -> [BoardTaskItem] {
        guard let ctx = modelContext else { return [] }
        let boardNames = boardNamesById()
        let descriptor = FetchDescriptor<TaskifyTask>(
            predicate: #Predicate<TaskifyTask> { t in
                t.deleted == false && t.completed == false
            },
            sortBy: [SortDescriptor(\.createdAt, order: .reverse)]
        )
        guard let tasks = try? ctx.fetch(descriptor) else { return [] }
        return tasks
            .filter { boardIds.contains($0.boardId) }
            .map {
                var item = BoardTaskItem.from($0)
                item.boardName = $0.boardName ?? boardNames[$0.boardId]
                return item
            }
    }

    public func fetchUpcomingCalendarEvents(boardIds: [String]) -> [UpcomingCalendarEventItem] {
        guard let ctx = modelContext else { return [] }
        let allowed = Set(boardIds)
        let boardNames = boardNamesById()
        let descriptor = FetchDescriptor<TaskifyCalendarEvent>(
            predicate: #Predicate<TaskifyCalendarEvent> { event in
                event.deleted == false
            },
            sortBy: [SortDescriptor(\.createdAt, order: .reverse)]
        )
        guard let events = try? ctx.fetch(descriptor) else { return [] }

        return events
            .filter { allowed.contains($0.boardId) }
            .map { event in
                UpcomingCalendarEventItem(
                    id: event.id,
                    boardId: event.boardId,
                    boardName: event.boardName ?? boardNames[event.boardId],
                    title: event.title.isEmpty ? "Untitled" : event.title,
                    kind: event.kind,
                    startDate: event.startDate,
                    endDate: event.endDate,
                    startISO: event.startISO,
                    endISO: event.endISO,
                    startTzid: event.startTzid,
                    endTzid: event.endTzid,
                    columnId: event.columnId,
                    summary: event.summary,
                    description: event.eventDescription,
                    locations: decodedStringArray(event.locationsJSON),
                    references: decodedStringArray(event.referencesJSON),
                    order: event.order,
                    createdAt: event.createdAt
                )
            }
    }

    public func refreshUpcomingCalendarEvents(boardIds: [String]) async {
        var seen = Set<String>()
        for boardId in boardIds where seen.insert(boardId).inserted {
            await refreshCalendarEvents(boardId: boardId)
        }
    }

    public func upcomingBoardDefinitions(boardIds: [String]) -> [UpcomingBoardDefinition] {
        boardIds.compactMap { boardId in
            if let board = fetchBoardModel(id: boardId) {
                return UpcomingBoardDefinition(
                    id: board.id,
                    name: board.name,
                    kind: board.kind,
                    columns: decodedColumns(board.columnsJSON)
                )
            }

            guard let fallbackName = boardName(boardId: boardId) else { return nil }
            return UpcomingBoardDefinition(id: boardId, name: fallbackName, kind: "lists", columns: [])
        }
    }

    // MARK: - Write: Create task

    /// Creates a task locally in SwiftData and publishes to relays.
    public func createTask(from editVM: TaskEditViewModel) async -> BoardTaskItem? {
        guard let ctx = modelContext else { return nil }
        let taskId = UUID().uuidString
        let task = TaskifyTask(
            id: taskId,
            boardId: editVM.location.boardId,
            title: editVM.title.trimmingCharacters(in: .whitespaces),
            completed: false,
            deleted: false,
            createdAt: Int(Date().timeIntervalSince1970)
        )
        task.boardName = boardName(boardId: editVM.location.boardId)
        task.sourceBoardId = editVM.location.boardId
        task.createdBy = currentPublicKeyHex()
        task.lastEditedBy = task.createdBy
        task.updatedAt = isoTimestamp(unixSeconds: task.createdAt)
        applyEditToModel(editVM, task: task)
        ctx.insert(task)
        try? ctx.save()

        // Publish to relays
        await publishTask(task, status: "open")
        _ = refreshActiveBoardItems()

        return BoardTaskItem.from(task)
    }

    /// Quick-add a task with just a title.
    public func quickAddTask(
        title: String,
        boardId: String,
        columnId: String?,
        dueISO: String? = nil,
        dueDateEnabled: Bool? = nil
    ) async -> BoardTaskItem? {
        guard let ctx = modelContext else { return nil }
        let task = TaskifyTask(
            id: UUID().uuidString,
            boardId: boardId,
            title: title,
            completed: false,
            deleted: false,
            createdAt: Int(Date().timeIntervalSince1970)
        )
        task.boardName = boardName(boardId: boardId)
        task.sourceBoardId = boardId
        task.createdBy = currentPublicKeyHex()
        task.lastEditedBy = task.createdBy
        task.updatedAt = isoTimestamp(unixSeconds: task.createdAt)
        task.column = columnId
        if let dueISO {
            task.dueISO = dueISO
        }
        if let dueDateEnabled {
            task.dueDateEnabled = dueDateEnabled
        }
        ctx.insert(task)
        try? ctx.save()

        await publishTask(task, status: "open")
        _ = refreshActiveBoardItems()
        return BoardTaskItem.from(task)
    }

    // MARK: - Write: Update task

    /// Updates an existing task and publishes the change.
    public func updateTask(taskId: String, from editVM: TaskEditViewModel) async -> BoardTaskItem? {
        guard let ctx = modelContext,
              let task = fetchTaskModel(id: taskId) else { return nil }
        applyEditToModel(editVM, task: task)
        task.lastEditedBy = currentPublicKeyHex() ?? task.lastEditedBy ?? task.createdBy
        task.updatedAt = ISO8601DateFormatter().string(from: Date())
        try? ctx.save()

        let status = task.completed ? "done" : (task.deleted ? "deleted" : "open")
        await publishTask(task, status: status)
        _ = refreshActiveBoardItems()
        return BoardTaskItem.from(task)
    }

    // MARK: - Write: Toggle complete

    /// Toggles a task's completion status and publishes.
    public func toggleComplete(taskId: String) async -> BoardTaskItem? {
        guard let ctx = modelContext,
              let task = fetchTaskModel(id: taskId) else { return nil }
        task.completed.toggle()
        if task.completed {
            task.completedAt = ISO8601DateFormatter().string(from: Date())
            task.completedBy = currentPublicKeyHex()
        } else {
            task.completedAt = nil
            task.completedBy = nil
        }
        task.lastEditedBy = currentPublicKeyHex() ?? task.lastEditedBy ?? task.createdBy
        task.updatedAt = ISO8601DateFormatter().string(from: Date())
        try? ctx.save()

        await publishTask(task, status: task.completed ? "done" : "open")
        _ = refreshActiveBoardItems()
        return BoardTaskItem.from(task)
    }

    // MARK: - Write: Delete task

    /// Soft-deletes a task and publishes the deletion.
    public func deleteTask(taskId: String) async -> Bool {
        guard let ctx = modelContext,
              let task = fetchTaskModel(id: taskId) else { return false }
        task.deleted = true
        task.lastEditedBy = currentPublicKeyHex() ?? task.lastEditedBy ?? task.createdBy
        task.updatedAt = ISO8601DateFormatter().string(from: Date())
        try? ctx.save()

        await publishTask(task, status: "deleted")
        _ = refreshActiveBoardItems()
        return true
    }

    // MARK: - Write: Toggle subtask

    /// Toggles a subtask's completion within a task.
    public func toggleSubtask(taskId: String, subtaskId: String) async -> BoardTaskItem? {
        guard let ctx = modelContext,
              let task = fetchTaskModel(id: taskId),
              let json = task.subtasksJSON,
              let data = json.data(using: .utf8),
              var subs = try? JSONDecoder().decode([Subtask].self, from: data),
              let idx = subs.firstIndex(where: { $0.id == subtaskId })
        else { return nil }

        subs[idx].completed.toggle()
        if let newData = try? JSONEncoder().encode(subs),
           let newJSON = String(data: newData, encoding: .utf8) {
            task.subtasksJSON = newJSON
        }
        task.updatedAt = ISO8601DateFormatter().string(from: Date())
        try? ctx.save()

        await publishTask(task, status: task.completed ? "done" : "open")
        _ = refreshActiveBoardItems()
        return BoardTaskItem.from(task)
    }

    // MARK: - Board management

    /// Creates a new board and adds it to the profile.
    public func createBoard(
        name: String,
        kind: String = "lists",
        columns: [BoardColumn] = [],
        children: [String] = [],
        relayHints: [String] = []
    ) async -> ProfileBoardEntry? {
        guard let ctx = modelContext, var prof = profile else { return nil }
        let boardId = UUID().uuidString
        let board = TaskifyBoard(id: boardId, name: name, kind: kind)
        if !columns.isEmpty {
            let colData = try? JSONEncoder().encode(columns)
            board.columnsJSON = colData.flatMap { String(data: $0, encoding: .utf8) }
        }
        if !children.isEmpty {
            board.childrenJSON = encodeJSONString(children)
        }
        let normalizedRelayHints = normalizeRelayList(relayHints)
        if !normalizedRelayHints.isEmpty {
            board.relayHintsJSON = encodeJSONString(normalizedRelayHints)
        }
        if !children.isEmpty {
            createCompoundChildStubs(children, relayHints: normalizeRelayList((profile?.relays ?? []) + normalizedRelayHints))
        }
        ctx.insert(board)
        try? ctx.save()

        let entry = ProfileBoardEntry(id: boardId, name: name)
        prof.boards.append(entry)
        profile = prof
        persistProfile(prof)
        await rebuildRelayPool()
        await publishBoardMetadata(board)
        boardDefinitionsVersion &+= 1

        return entry
    }

    /// Joins an existing board by ID (from a share link).
    public func joinBoard(boardId: String, name: String, relays: [String]? = nil) async -> ProfileBoardEntry? {
        guard let ctx = modelContext, var prof = profile else { return nil }
        let relayHints = normalizeRelayList(relays ?? [])

        // Don't re-add if already a member
        if prof.boards.contains(where: { $0.id == boardId }) {
            if let board = fetchBoardModel(id: boardId), !relayHints.isEmpty {
                board.relayHintsJSON = encodeJSONString(relayHints)
                try? ctx.save()
                await rebuildRelayPool()
                await refreshBoardMetadata(boardId: boardId)
            }
            return prof.boards.first(where: { $0.id == boardId })
        }

        let board = TaskifyBoard(id: boardId, name: name, kind: "lists")
        if !relayHints.isEmpty {
            board.relayHintsJSON = encodeJSONString(relayHints)
        }
        ctx.insert(board)
        try? ctx.save()

        let entry = ProfileBoardEntry(id: boardId, name: name)
        prof.boards.append(entry)
        profile = prof
        persistProfile(prof)
        await rebuildRelayPool()
        await refreshBoardMetadata(boardId: boardId)
        await refreshAllBoardMetadata(boardIds: activeSourceBoardIds(for: boardId).filter { $0 != boardId })
        boardDefinitionsVersion &+= 1

        // Start syncing this board
        let _ = await subscribeToBoard(boardId)
        return entry
    }

    public func boardDefinition(boardId: String) -> ListBoardDefinition? {
        guard let board = fetchBoardModel(id: boardId) else { return nil }
        return listBoardDefinition(from: board)
    }

    public func boardSettings(boardId: String) -> BoardSettingsSnapshot? {
        guard let board = fetchBoardModel(id: boardId) else { return nil }
        let children = decodedStringArray(board.childrenJSON).map { childId in
            let childBoard = fetchBoardModel(id: childId)
            return BoardChildSnapshot(
                id: childId,
                name: childBoard?.name ?? boardName(boardId: childId) ?? "Linked board",
                relayHints: childBoard.map { decodedStringArray($0.relayHintsJSON) } ?? []
            )
        }
        return BoardSettingsSnapshot(
            id: board.id,
            name: board.name,
            kind: board.kind,
            columns: decodedColumns(board.columnsJSON),
            children: children,
            clearCompletedDisabled: board.clearCompletedDisabled,
            indexCardEnabled: board.indexCardEnabled,
            hideChildBoardNames: board.hideChildBoardNames,
            relayHints: decodedStringArray(board.relayHintsJSON)
        )
    }

    public func relatedBoardDefinitions(for boardId: String) -> [ListBoardDefinition] {
        guard let current = boardDefinition(boardId: boardId) else { return [] }
        if current.kind != .compound { return [current] }

        var definitions = [current]
        for childId in current.children {
            if let child = boardDefinition(boardId: childId) {
                definitions.append(child)
            }
        }
        return definitions
    }

    public func boardKind(boardId: String) -> String? {
        fetchBoardModel(id: boardId)?.kind
    }

    public func boardRelayHints(boardId: String) -> [String] {
        guard let board = fetchBoardModel(id: boardId) else { return [] }
        return decodedStringArray(board.relayHintsJSON)
    }

    public func profileBoardSummaries() -> [ProfileBoardSummary] {
        let storedById = Dictionary(uniqueKeysWithValues: fetchStoredBoards().map { ($0.id, $0) })
        var seen = Set<String>()
        var summaries: [ProfileBoardSummary] = []

        for entry in profile?.boards ?? [] {
            guard seen.insert(entry.id).inserted else { continue }
            let stored = storedById[entry.id]
            summaries.append(
                ProfileBoardSummary(
                    id: entry.id,
                    name: stored?.name ?? entry.name,
                    kind: stored?.kind ?? "lists",
                    archived: stored?.archived ?? false,
                    hidden: stored?.hidden ?? false,
                    relayHints: stored.map { decodedStringArray($0.relayHintsJSON) } ?? []
                )
            )
        }

        return summaries
    }

    public func availableCompoundBoards(excluding boardId: String, selectedChildren: [String] = []) -> [BoardOption] {
        let selectedIds = Set(selectedChildren)
        let storedById = Dictionary(uniqueKeysWithValues: fetchStoredBoards().map { ($0.id, $0) })
        var seen = Set<String>()
        var options: [BoardOption] = []

        for entry in profile?.boards ?? [] {
            guard entry.id != boardId, !selectedIds.contains(entry.id), seen.insert(entry.id).inserted else { continue }
            if let stored = storedById[entry.id] {
                guard stored.kind == "lists", stored.archived == false else { continue }
                options.append(BoardOption(id: stored.id, name: stored.name))
            } else {
                options.append(BoardOption(id: entry.id, name: entry.name))
            }
        }

        return options.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    public func boardShareEnvelope(boardId: String) -> String? {
        guard let board = fetchBoardModel(id: boardId) else { return nil }
        return BoardShareContract.buildEnvelopeString(
            boardId: board.id,
            boardName: board.name,
            relays: effectiveRelays(for: board)
        )
    }

    /// Soft-deletes all completed tasks visible to the board's scope and publishes deletions.
    public func clearCompletedTasks(boardId: String) async -> Int {
        guard let ctx = modelContext else { return 0 }
        let scopedBoardIDs = Set(activeSourceBoardIds(for: boardId))
        guard !scopedBoardIDs.isEmpty else { return 0 }

        let descriptor = FetchDescriptor<TaskifyTask>(
            predicate: #Predicate<TaskifyTask> { task in
                task.deleted == false && task.completed == true
            },
            sortBy: [SortDescriptor(\.createdAt, order: .reverse)]
        )
        guard let storedTasks = try? ctx.fetch(descriptor) else { return 0 }

        let editorPublicKey = currentPublicKeyHex()
        let completedTasks = storedTasks.filter { scopedBoardIDs.contains($0.boardId) }
        guard !completedTasks.isEmpty else { return 0 }

        for task in completedTasks {
            task.deleted = true
            task.lastEditedBy = editorPublicKey ?? task.lastEditedBy ?? task.createdBy
        }
        try? ctx.save()

        for task in completedTasks {
            await publishTask(task, status: "deleted")
        }

        _ = refreshActiveBoardItems()
        return completedTasks.count
    }

    @discardableResult
    public func ensureCompoundChildBoard(_ child: BoardChildSnapshot) async -> BoardChildSnapshot? {
        let childId = child.id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !childId.isEmpty else { return nil }
        if let existing = fetchBoardModel(id: childId), existing.kind != "lists" {
            return nil
        }

        let normalizedRelays = normalizeRelayList(child.relayHints)
        let requestedName = normalizedBoardName(child.name) ?? "Linked board"
        let board = fetchOrCreateBoard(boardId: childId)
        let isProfileBoard = profile?.boards.contains(where: { $0.id == childId }) == true
        var needsSave = false
        var needsRelayRefresh = false

        if board.columnsJSON == nil {
            board.columnsJSON = encodeJSONString([BoardColumn(id: "items", name: "Items")])
            needsSave = true
        }

        if !isProfileBoard && (board.hidden == false || board.archived == false) {
            board.hidden = true
            board.archived = true
            needsSave = true
        }

        if isGenericBoardName(board.name), requestedName != "Linked board" {
            board.name = requestedName
            needsSave = true
        }

        if !normalizedRelays.isEmpty {
            let existing = decodedStringArray(board.relayHintsJSON)
            if existing != normalizedRelays {
                board.relayHintsJSON = encodeJSONString(normalizedRelays)
                needsSave = true
                needsRelayRefresh = true
            }
        }

        if needsSave {
            try? modelContext?.save()
        }
        if needsRelayRefresh {
            await rebuildRelayPool()
        }
        if needsRelayRefresh || board.metadataCreatedAt == nil {
            await refreshBoardMetadata(boardId: childId)
        }

        let resolvedBoard = fetchBoardModel(id: childId) ?? board
        return BoardChildSnapshot(
            id: childId,
            name: resolvedBoard.name,
            relayHints: decodedStringArray(resolvedBoard.relayHintsJSON)
        )
    }

    public func republishBoardMetadata(boardId: String) async {
        guard let board = fetchBoardModel(id: boardId) else { return }
        await publishBoardMetadata(board)
        boardDefinitionsVersion &+= 1
    }

    // MARK: - Internal helpers

    private func persistProfile(_ profile: TaskifyProfile) {
        try? KeychainStore.saveProfile(profile)
    }

    private func ensureStoredBoards(_ entries: [ProfileBoardEntry]) {
        for entry in entries {
            let board = fetchOrCreateBoard(boardId: entry.id)
            if board.name == "Board" || board.name == "Unknown" {
                board.name = entry.name
            }
        }
        try? modelContext?.save()
    }

    private func rebuildRelayPool() async {
        let relayURLs = allRelayURLs()
        await relayPool?.disconnect()
        relayConnected = 0
        let pool = RelayPool(
            relayURLs: relayURLs,
            onConnectionSummaryChange: { [weak self] summary in
                Task { @MainActor [weak self] in
                    self?.relayConnected = summary.connected
                }
            },
            onPermanentFailure: { [weak self] url, error in
                Task { @MainActor [weak self] in
                    self?.handlePermanentRelayFailure(url: url, error: error)
                }
            }
        )
        relayPool = pool
        await pool.connect()
        relayConnected = await pool.connectedCount()
    }

    private func allRelayURLs() -> [String] {
        let profileRelays = profile?.relays ?? []
        let boardRelays = allStoredRelayHints()
        return normalizeRelayList(profileRelays + boardRelays)
    }

    private func allStoredRelayHints() -> [String] {
        fetchStoredBoards().flatMap { decodedStringArray($0.relayHintsJSON) }
    }

    private func refreshAllBoardMetadata(boardIds: [String]) async {
        var seen = Set<String>()
        for boardId in boardIds where seen.insert(boardId).inserted {
            await refreshBoardMetadata(boardId: boardId)
        }
    }

    private func refreshBoardMetadata(boardId: String) async {
        guard let pool = relayPool else { return }
        let bTag = boardTagHash(boardId)
        let events = await pool.fetchEvents(filters: [
            [
                "kinds": [TaskifyEventKind.boardDefinition.rawValue],
                "#d": [bTag],
                "limit": 20,
            ],
            [
                "kinds": [TaskifyEventKind.boardDefinition.rawValue],
                "#b": [bTag],
                "limit": 20,
            ],
        ])

        guard let latest = events.max(by: { $0.created_at < $1.created_at }) else { return }
        applyIncomingBoardDefinition(latest, boardId: boardId)
    }

    private func refreshCalendarEvents(boardId: String) async {
        guard let pool = relayPool else { return }
        let bTag = boardTagHash(boardId)
        let events = await pool.fetchEvents(
            filters: [[
                "kinds": [TaskifyEventKind.calendarEvent.rawValue],
                "#b": [bTag],
                "limit": 500,
            ]],
            hardTimeoutMs: 12_000,
            eoseGraceMs: 200,
            inactivityMs: 3_000
        )
        mergeIncomingCalendarEvents(events, boardId: boardId)
    }

    private func applyIncomingBoardDefinition(_ event: NostrEvent, boardId: String) {
        let board = fetchOrCreateBoard(boardId: boardId)
        if let last = board.metadataCreatedAt, event.created_at < last { return }

        let previousScope = activeBoardId == boardId ? activeSourceBoardIds(for: boardId) : []
        let decoded: BoardDefinitionPayload?
        if let plaintext = try? decryptTaskPayload(event.content, boardId: boardId) {
            decoded = BoardDefinitionCodec.decode(plaintext)
        } else {
            decoded = BoardDefinitionCodec.decode(event.content)
        }
        let metadata = BoardDefinitionCodec.mergedMetadata(payload: decoded, tags: event.tags)
        guard !metadata.isEmpty else { return }

        board.metadataCreatedAt = event.created_at
        if let kind = metadata.kind {
            board.kind = kind
        }
        if let name = normalizedBoardName(metadata.name) {
            board.name = name
            syncProfileBoardName(boardId: boardId, name: name)
            syncStoredBoardNameReferences(boardId: boardId, name: name)
        }
        if let clearCompletedDisabled = metadata.clearCompletedDisabled {
            board.clearCompletedDisabled = clearCompletedDisabled
        }
        if let columns = metadata.columns {
            board.columnsJSON = encodeJSONString(columns)
        }
        if let children = metadata.children {
            let normalizedChildren = normalizeCompoundChildren(children, parentBoardId: boardId)
            board.childrenJSON = encodeJSONString(normalizedChildren)
            createCompoundChildStubs(normalizedChildren, relayHints: effectiveRelays(for: board))
        }
        if let listIndex = metadata.indexCardEnabled {
            board.indexCardEnabled = listIndex
        }
        if let hideBoardNames = metadata.hideChildBoardNames {
            board.hideChildBoardNames = hideBoardNames
        }
        if let archived = metadata.archived {
            board.archived = archived
        }
        if let hidden = metadata.hidden {
            board.hidden = hidden
        }
        if let sortMode = metadata.sortMode {
            board.sortMode = sortMode
            board.sortDirection = metadata.sortDirection ?? board.sortDirection ?? "asc"
        }

        try? modelContext?.save()
        boardDefinitionsVersion &+= 1
        _ = refreshActiveBoardItems()

        let updatedScope = activeBoardId == boardId ? activeSourceBoardIds(for: boardId) : []
        if activeBoardId == boardId, updatedScope != previousScope, let activeBoardId {
            Task { [weak self] in
                guard let self else { return }
                let _ = await self.subscribeToBoard(activeBoardId)
            }
        }
    }

    private func mergeIncomingCalendarEvents(_ events: [NostrEvent], boardId: String) {
        guard let ctx = modelContext else { return }

        var latestById: [String: NostrEvent] = [:]
        for event in events where event.kind == TaskifyEventKind.calendarEvent.rawValue {
            guard let eventId = event.tagValue("d"), !eventId.isEmpty else { continue }
            if let existing = latestById[eventId] {
                if event.created_at >= existing.created_at {
                    latestById[eventId] = event
                }
            } else {
                latestById[eventId] = event
            }
        }

        guard !latestById.isEmpty else { return }

        let resolvedBoardName = boardName(boardId: boardId)
        var didChange = false

        for (eventId, event) in latestById {
            guard let payloadRaw = try? decryptCalendarPayload(event.content, boardId: boardId),
                  let payload = payloadRaw as? [String: Any] else {
                continue
            }

            let descriptor = FetchDescriptor<TaskifyCalendarEvent>(
                predicate: #Predicate<TaskifyCalendarEvent> { existing in
                    existing.id == eventId
                }
            )
            let existing = try? ctx.fetch(descriptor).first
            if let existing, event.created_at < existing.createdAt {
                continue
            }

            let deleted = payload["deleted"] as? Bool == true
            if let existing {
                applyCalendarPayloadToModel(
                    payload,
                    event: event,
                    boardId: boardId,
                    boardName: resolvedBoardName,
                    calendarEvent: existing,
                    deleted: deleted
                )
                didChange = true
            } else if !deleted {
                let title = trimmedString(payload["title"] as? String) ?? "Untitled"
                let kind = trimmedString(payload["kind"] as? String) ?? "time"
                let calendarEvent = TaskifyCalendarEvent(
                    id: eventId,
                    boardId: boardId,
                    title: title,
                    kind: kind,
                    createdAt: event.created_at
                )
                applyCalendarPayloadToModel(
                    payload,
                    event: event,
                    boardId: boardId,
                    boardName: resolvedBoardName,
                    calendarEvent: calendarEvent,
                    deleted: false
                )
                ctx.insert(calendarEvent)
                didChange = true
            }
        }

        guard didChange else { return }
        try? ctx.save()
        calendarEventsVersion &+= 1
    }

    private func applyCalendarPayloadToModel(
        _ payload: [String: Any],
        event: NostrEvent,
        boardId: String,
        boardName: String?,
        calendarEvent: TaskifyCalendarEvent,
        deleted: Bool
    ) {
        calendarEvent.boardId = boardId
        calendarEvent.boardName = boardName
        calendarEvent.title = trimmedString(payload["title"] as? String) ?? calendarEvent.title
        calendarEvent.summary = trimmedString(payload["summary"] as? String)
        if let kind = trimmedString(payload["kind"] as? String) {
            calendarEvent.kind = kind
        }
        calendarEvent.startDate = trimmedString(payload["startDate"] as? String)
        calendarEvent.endDate = trimmedString(payload["endDate"] as? String)
        calendarEvent.startISO = trimmedString(payload["startISO"] as? String)
        calendarEvent.endISO = trimmedString(payload["endISO"] as? String)
        calendarEvent.startTzid = trimmedString(payload["startTzid"] as? String)
        calendarEvent.endTzid = trimmedString(payload["endTzid"] as? String)
        calendarEvent.eventDescription = trimmedString(payload["description"] as? String)
        calendarEvent.columnId = trimmedString(event.tagValue("col"))
        calendarEvent.order = trimmedString(event.tagValue("order")).flatMap(Int.init)
        calendarEvent.deleted = deleted
        calendarEvent.createdAt = event.created_at
        calendarEvent.locationsJSON = encodeJSONString(normalizedStringArray(payload["locations"]))
        calendarEvent.referencesJSON = encodeJSONString(normalizedStringArray(payload["references"]))
        calendarEvent.documentsJSON = jsonString(fromJSONObject: payload["documents"])
    }

    private func createCompoundChildStubs(_ childIds: [String], relayHints: [String]) {
        for childId in childIds {
            let child = fetchOrCreateBoard(boardId: childId)
            let isProfileBoard = profile?.boards.contains(where: { $0.id == childId }) == true
            if child.columnsJSON == nil {
                child.columnsJSON = encodeJSONString([BoardColumn(id: "items", name: "Items")])
            }
            if !isProfileBoard {
                child.hidden = true
                child.archived = true
            }
            if child.relayHintsJSON == nil && !relayHints.isEmpty {
                child.relayHintsJSON = encodeJSONString(relayHints)
            }
        }
        try? modelContext?.save()
    }

    private func subscribeToBoardMetadata(boardIds: [String]) {
        guard let pool = relayPool else { return }

        var seen = Set<String>()
        let uniqueBoardIds = boardIds.filter { seen.insert($0).inserted }
        guard !uniqueBoardIds.isEmpty else { return }

        let boardTags = uniqueBoardIds.map(boardTagHash)
        let boardTagMap = Dictionary(uniqueKeysWithValues: zip(boardTags, uniqueBoardIds))
        let filters: [[String: Any]] = [
            [
                "kinds": [TaskifyEventKind.boardDefinition.rawValue],
                "#d": boardTags,
            ],
            [
                "kinds": [TaskifyEventKind.boardDefinition.rawValue],
                "#b": boardTags,
            ],
        ]

        Task { [weak self] in
            guard let self else { return }
            let key = await pool.subscribe(
                filters: filters,
                onEvent: { [weak self] event, _ in
                    guard let self else { return }
                    Task { @MainActor in
                        guard let boardId = self.boardId(forBoardDefinitionEvent: event, boardTagMap: boardTagMap) else {
                            return
                        }
                        self.applyIncomingBoardDefinition(event, boardId: boardId)
                    }
                },
                onEose: { _ in }
            )
            await MainActor.run {
                _ = self.activeSubscriptionKeys.insert(key)
            }
        }
    }

    private func subscribeToBoardTasks(boardId: String) {
        guard let pool = relayPool else {
            pendingBoardSyncIDs.removeAll()
            syncing = false
            return
        }

        let sourceBoardIds = activeSourceBoardIds(for: boardId)
        guard !sourceBoardIds.isEmpty else {
            pendingBoardSyncIDs.removeAll()
            syncing = false
            return
        }

        pendingBoardSyncIDs = Set(sourceBoardIds)

        for sourceBoardId in sourceBoardIds {
            let bTag = boardTagHash(sourceBoardId)
            let board = fetchOrCreateBoard(boardId: sourceBoardId)
            let since: Int
            if let cursor = board.lastSyncAt, cursor > 0 {
                since = max(0, cursor - 300)
            } else {
                since = Int(Date().timeIntervalSince1970) - 30 * 86400
            }

            let filter: [String: Any] = [
                "kinds": [TaskifyEventKind.task.rawValue],
                "#b": [bTag],
                "since": since,
            ]

            Task { [weak self] in
                guard let self else { return }
                let key = await pool.subscribe(
                    filters: [filter],
                    onEvent: { [weak self] event, _ in
                        guard let self else { return }
                        Task { @MainActor in
                            self.handleIncomingTaskEvent(event, boardId: sourceBoardId)
                        }
                    },
                    onEose: { [weak self] _ in
                        Task { @MainActor in
                            guard let self else { return }
                            self.pendingBoardSyncIDs.remove(sourceBoardId)
                            guard self.pendingBoardSyncIDs.isEmpty else { return }
                            self.syncing = false
                            _ = self.refreshActiveBoardItems()
                        }
                    }
                )
                await MainActor.run {
                    _ = self.activeSubscriptionKeys.insert(key)
                }
            }
        }

        Task {
            try? await Task.sleep(nanoseconds: 25_000_000_000)
            await MainActor.run {
                self.pendingBoardSyncIDs.removeAll()
                self.syncing = false
                _ = self.refreshActiveBoardItems()
            }
        }
    }

    private func refreshActiveBoardItems() -> [BoardTaskItem] {
        guard let activeBoardId else {
            activeBoardItems = []
            return []
        }
        let tasks = fetchTasksFromStore(boardIds: activeSourceBoardIds(for: activeBoardId))
        activeBoardItems = tasks
        return tasks
    }

    private func activeSourceBoardIds(for boardId: String) -> [String] {
        guard let board = fetchBoardModel(id: boardId) else {
            return BoardScopeResolver.scopedBoardIDs(
                currentBoardId: boardId,
                kind: nil,
                childBoardIDs: []
            )
        }
        return BoardScopeResolver.scopedBoardIDs(
            currentBoardId: board.id,
            kind: board.kind,
            childBoardIDs: decodedStringArray(board.childrenJSON)
        )
    }

    private func effectiveRelays(for board: TaskifyBoard) -> [String] {
        normalizeRelayList((profile?.relays ?? []) + decodedStringArray(board.relayHintsJSON))
    }

    private func boardId(forBoardDefinitionEvent event: NostrEvent, boardTagMap: [String: String]) -> String? {
        if let dTag = event.tagValue("d"), let boardId = boardTagMap[dTag] {
            return boardId
        }
        if let bTag = event.tagValue("b"), let boardId = boardTagMap[bTag] {
            return boardId
        }
        return nil
    }

    private func syncProfileBoardName(boardId: String, name: String) {
        guard var prof = profile,
              let index = prof.boards.firstIndex(where: { $0.id == boardId }),
              prof.boards[index].name != name else { return }
        prof.boards[index].name = name
        profile = prof
        persistProfile(prof)
    }

    private func syncStoredBoardNameReferences(boardId: String, name: String) {
        guard let ctx = modelContext else { return }

        let taskDescriptor = FetchDescriptor<TaskifyTask>(
            predicate: #Predicate<TaskifyTask> { task in
                task.boardId == boardId
            }
        )
        let eventDescriptor = FetchDescriptor<TaskifyCalendarEvent>(
            predicate: #Predicate<TaskifyCalendarEvent> { event in
                event.boardId == boardId
            }
        )

        var didChange = false
        let tasks = (try? ctx.fetch(taskDescriptor)) ?? []
        for task in tasks where task.boardName != name {
            task.boardName = name
            didChange = true
        }

        let calendarEvents = (try? ctx.fetch(eventDescriptor)) ?? []
        for event in calendarEvents where event.boardName != name {
            event.boardName = name
            didChange = true
        }

        guard didChange else { return }
        try? ctx.save()
        calendarEventsVersion &+= 1
    }

    private func boardNamesById() -> [String: String] {
        guard let ctx = modelContext else {
            return Dictionary(uniqueKeysWithValues: (profile?.boards ?? []).map { ($0.id, $0.name) })
        }
        let descriptor = FetchDescriptor<TaskifyBoard>()
        let stored = (try? ctx.fetch(descriptor)) ?? []
        var names = Dictionary(uniqueKeysWithValues: stored.map { ($0.id, $0.name) })
        for entry in profile?.boards ?? [] where names[entry.id] == nil {
            names[entry.id] = entry.name
        }
        return names
    }

    private func boardName(boardId: String) -> String? {
        boardNamesById()[boardId]
    }

    private func listBoardDefinition(from board: TaskifyBoard) -> ListBoardDefinition {
        let kind: ListBoardKind
        switch board.kind {
        case "lists": kind = .lists
        case "compound": kind = .compound
        default: kind = .other
        }
        return ListBoardDefinition(
            id: board.id,
            name: board.name,
            kind: kind,
            columns: decodedColumns(board.columnsJSON),
            children: decodedStringArray(board.childrenJSON),
            hideChildBoardNames: board.hideChildBoardNames
        )
    }

    private func fetchBoardModel(id: String) -> TaskifyBoard? {
        guard let ctx = modelContext else { return nil }
        let descriptor = FetchDescriptor<TaskifyBoard>(
            predicate: #Predicate<TaskifyBoard> { b in b.id == id }
        )
        return try? ctx.fetch(descriptor).first
    }

    private func fetchStoredBoards() -> [TaskifyBoard] {
        guard let ctx = modelContext else { return [] }
        let descriptor = FetchDescriptor<TaskifyBoard>()
        return (try? ctx.fetch(descriptor)) ?? []
    }

    private func decodedColumns(_ raw: String?) -> [BoardColumn] {
        guard let raw,
              let data = raw.data(using: .utf8),
              let columns = try? JSONDecoder().decode([BoardColumn].self, from: data) else {
            return []
        }
        return columns
    }

    private func decodedStringArray(_ raw: String?) -> [String] {
        guard let raw,
              let data = raw.data(using: .utf8),
              let values = try? JSONDecoder().decode([String].self, from: data) else {
            return []
        }
        return values
    }

    private func normalizedStringArray(_ raw: Any?) -> [String] {
        guard let values = raw as? [Any] else { return [] }
        return values.compactMap { value in
            trimmedString(value as? String)
        }
    }

    private func trimmedString(_ value: String?) -> String? {
        value?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }

    private func encodeJSONString<T: Encodable>(_ value: T) -> String? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func jsonString(fromJSONObject value: Any?) -> String? {
        guard let value,
              JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    private func normalizeRelayList(_ relays: [String]) -> [String] {
        var seen = Set<String>()
        var ordered: [String] = []
        for relay in relays.compactMap(RelayBlocklistStore.normalize) where seen.insert(relay).inserted {
            ordered.append(relay)
        }
        return ordered
    }

    private func handlePermanentRelayFailure(url: String, error: NSError?) {
        RelayBlocklistStore.add(url)

        var didPrune = false

        if var prof = profile {
            let filteredRelays = normalizeRelayList(prof.relays.filter { $0 != url })
            if filteredRelays != prof.relays {
                prof.relays = filteredRelays
                profile = prof
                persistProfile(prof)
                didPrune = true
            }
        }

        if let ctx = modelContext {
            var updatedBoards = false
            for board in fetchStoredBoards() {
                let filteredHints = normalizeRelayList(decodedStringArray(board.relayHintsJSON).filter { $0 != url })
                let existingHints = decodedStringArray(board.relayHintsJSON)
                if filteredHints != existingHints {
                    board.relayHintsJSON = filteredHints.isEmpty ? nil : encodeJSONString(filteredHints)
                    updatedBoards = true
                }
            }
            if updatedBoards {
                try? ctx.save()
                didPrune = true
            }
        }

        let host = URLComponents(string: url)?.host ?? url
        let detail = error?.localizedDescription ?? "TLS trust failed"
        lastError = didPrune
            ? "Removed relay \(host) after iOS rejected its TLS certificate (\(detail))."
            : "iOS rejected relay \(host)'s TLS certificate (\(detail))."
    }

    private func currentPublicKeyHex() -> String? {
        guard let npub = profile?.npub else { return nil }
        return try? NostrIdentityService.normalizePublicKeyInput(npub)
    }

    private func contactsRelayURLs() -> [String] {
        let contactRelays = fetchContacts().flatMap(\.relays)
        return normalizeRelayList((profile?.relays ?? []) + contactRelays)
    }

    private func fetchContactModels() -> [TaskifyContact] {
        guard let ctx = modelContext else { return [] }
        let descriptor = FetchDescriptor<TaskifyContact>()
        return (try? ctx.fetch(descriptor)) ?? []
    }

    private func fetchPublicFollowModels() -> [TaskifyPublicFollow] {
        guard let ctx = modelContext else { return [] }
        let descriptor = FetchDescriptor<TaskifyPublicFollow>()
        return (try? ctx.fetch(descriptor)) ?? []
    }

    private func findContactModel(id: String?, npub: String?) -> TaskifyContact? {
        let contacts = fetchContactModels()
        if let id, let matched = contacts.first(where: { $0.id == id }) {
            return matched
        }
        guard let npub, !npub.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let publicKeyHex = try? NostrIdentityService.normalizePublicKeyInput(npub) else {
            return nil
        }
        return contacts.first(where: {
            guard let existingHex = try? NostrIdentityService.normalizePublicKeyInput($0.npub) else { return false }
            return existingHex == publicKeyHex
        })
    }

    private func mergeSyncedContacts(_ incoming: [TaskifyContactRecord], envelopeUpdatedAt: Int) {
        guard let ctx = modelContext else { return }
        var current = fetchContacts()
        var byKey: [String: Int] = [:]
        for (index, contact) in current.enumerated() {
            let key = formatContactNpub(contact.npub).lowercased().nilIfEmpty ?? "id:\(contact.id)"
            byKey[key] = index
        }
        for entry in incoming {
            let npubKey = formatContactNpub(entry.npub).lowercased().nilIfEmpty
            let key = npubKey ?? "id:\(entry.id)"
            if let existingIndex = byKey[key] {
                let prev = current[existingIndex]
                current[existingIndex] = TaskifyContactRecord(
                    id: prev.id,
                    kind: entry.kind,
                    name: entry.name.isEmpty ? prev.name : entry.name,
                    address: entry.address.isEmpty ? prev.address : entry.address,
                    paymentRequest: entry.paymentRequest.isEmpty ? prev.paymentRequest : entry.paymentRequest,
                    npub: entry.npub.isEmpty ? prev.npub : entry.npub,
                    username: entry.username ?? prev.username,
                    displayName: entry.displayName ?? prev.displayName,
                    nip05: entry.nip05 ?? prev.nip05,
                    about: entry.about ?? prev.about,
                    picture: entry.picture ?? prev.picture,
                    relays: entry.relays.isEmpty ? prev.relays : entry.relays,
                    createdAt: prev.createdAt,
                    updatedAt: max(prev.updatedAt, envelopeUpdatedAt),
                    source: prev.source ?? .sync
                )
            } else {
                current.append(entry)
            }
        }

        for record in current {
            let model = findContactModel(id: record.id, npub: nil) ?? TaskifyContact(
                id: record.id,
                kind: record.kind,
                createdAt: record.createdAt,
                updatedAt: record.updatedAt,
                source: record.source
            )
            if findContactModel(id: record.id, npub: nil) == nil {
                ctx.insert(model)
            }
            model.kind = record.kind
            model.name = record.name
            model.address = record.address
            model.paymentRequest = record.paymentRequest
            model.npub = record.npub
            model.username = record.username
            model.displayName = record.displayName
            model.nip05 = record.nip05
            model.about = record.about
            model.picture = record.picture
            model.relays = record.relays
            model.createdAt = record.createdAt
            model.updatedAt = record.updatedAt
            model.source = record.source
        }

        try? ctx.save()
        contactsVersion &+= 1
    }

    private func persistPublicFollows(_ follows: [TaskifyPublicFollowRecord]) {
        guard let ctx = modelContext else { return }
        let existing = Dictionary(uniqueKeysWithValues: fetchPublicFollowModels().map { ($0.pubkey, $0) })
        var touched = Set<String>()
        for follow in follows {
            let model = existing[follow.pubkey] ?? TaskifyPublicFollow(pubkey: follow.pubkey)
            if existing[follow.pubkey] == nil {
                ctx.insert(model)
            }
            model.apply(record: follow)
            touched.insert(follow.pubkey)
        }
        for (pubkey, model) in existing where !touched.contains(pubkey) {
            ctx.delete(model)
        }
        try? ctx.save()
        publicFollowsVersion &+= 1
    }

    private func saveNip05Check(_ check: Nip05CheckState, for contactId: String) {
        var checks = loadNip05Checks()
        let normalizedId = contactId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedId.isEmpty else { return }
        if checks[normalizedId] == check {
            return
        }
        checks[normalizedId] = check
        persistNip05Checks(checks)
    }

    private func removeNip05Check(contactId: String) {
        var checks = loadNip05Checks()
        let normalizedId = contactId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedId.isEmpty, checks.removeValue(forKey: normalizedId) != nil else { return }
        persistNip05Checks(checks)
    }

    private func persistNip05Checks(_ checks: [String: Nip05CheckState]) {
        guard let profile else { return }
        let existing = ContactPreferencesStore.loadNip05Checks(npub: profile.npub)
        guard existing != checks else { return }
        ContactPreferencesStore.saveNip05Checks(checks, npub: profile.npub)
        contactNip05ChecksVersion &+= 1
    }

    private func enrichPublicFollows(_ follows: [TaskifyPublicFollowRecord], relays: [String]) async -> [TaskifyPublicFollowRecord] {
        guard let pool = relayPool, !follows.isEmpty else { return follows }
        let pubkeys = follows.map(\.pubkey)
        let events = await pool.fetchEvents(filters: [[
            "kinds": [TaskifyEventKind.profileMetadata.rawValue],
            "authors": pubkeys,
            "limit": max(pubkeys.count * 3, 50),
        ]], hardTimeoutMs: 10_000, eoseGraceMs: 250, inactivityMs: 2_000)
        let latestByPubkey = Dictionary(grouping: events, by: \.pubkey).compactMapValues { group in
            group.max(by: { $0.created_at < $1.created_at })
        }
        return follows.map { follow in
            guard let event = latestByPubkey[follow.pubkey] else { return follow }
            let meta = parseProfileMetadata(content: event.content)
            return TaskifyPublicFollowRecord(
                pubkey: follow.pubkey,
                relay: follow.relay,
                petname: follow.petname,
                username: follow.username ?? meta.username.nilIfEmpty,
                nip05: follow.nip05 ?? normalizeNip05(meta.nip05),
                updatedAt: max(follow.updatedAt, event.created_at * 1000)
            )
        }
    }

    private func hydrateLookupDraft(
        npub: String,
        relayHints: [String],
        fallback: TaskifyContactDraft
    ) async throws -> TaskifyContactDraft {
        let normalizedHex = try NostrIdentityService.normalizePublicKeyInput(npub)
        let relays = normalizeRelayList(relayHints + (profile?.relays ?? []))
        guard let pool = relayPool, !relays.isEmpty else {
            return TaskifyContactDraft(
                id: fallback.id,
                kind: .nostr,
                name: fallback.name,
                address: fallback.address,
                paymentRequest: fallback.paymentRequest,
                npub: npub,
                username: fallback.username,
                displayName: fallback.displayName,
                nip05: fallback.nip05,
                about: fallback.about,
                picture: fallback.picture,
                relays: normalizeRelayList(relayHints),
                source: fallback.source
            )
        }
        let events = await pool.fetchEvents(filters: [[
            "kinds": [TaskifyEventKind.profileMetadata.rawValue],
            "authors": [normalizedHex],
            "limit": 1,
        ]], hardTimeoutMs: 8_000, eoseGraceMs: 250, inactivityMs: 1_500)
        let latest = events.max(by: { $0.created_at < $1.created_at })
        let meta = latest.map { parseProfileMetadata(content: $0.content) } ?? TaskifyProfileMetadata()
        return TaskifyContactDraft(
            id: fallback.id,
            kind: .nostr,
            name: fallback.name.isEmpty ? (meta.displayName.isEmpty ? meta.username : meta.displayName) : fallback.name,
            address: fallback.address.isEmpty ? meta.lud16 : fallback.address,
            paymentRequest: fallback.paymentRequest,
            npub: npub,
            username: fallback.username.isEmpty ? meta.username : fallback.username,
            displayName: fallback.displayName.isEmpty ? meta.displayName : fallback.displayName,
            nip05: fallback.nip05.isEmpty ? meta.nip05 : fallback.nip05,
            about: fallback.about.isEmpty ? meta.about : fallback.about,
            picture: fallback.picture.isEmpty ? meta.picture : fallback.picture,
            relays: normalizeRelayList(relayHints),
            source: fallback.source
        )
    }

    private func applyProfileField(
        _ incoming: String?,
        current: String?,
        allowReplace: Bool,
        update: (String?) -> Void
    ) -> Bool {
        let nextValue = incoming?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        let currentValue = current?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        guard nextValue != nil else { return false }
        if allowReplace || currentValue == nil {
            guard nextValue != currentValue else { return false }
            update(nextValue)
            return true
        }
        return false
    }

    private func normalizedBoardName(_ value: String?) -> String? {
        value?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty
    }

    private func isGenericBoardName(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed == "Board" || trimmed == "Unknown" || trimmed == "Linked board"
    }

    private func normalizeCompoundChildren(_ children: [String], parentBoardId: String) -> [String] {
        var seen = Set<String>()
        var ordered: [String] = []
        let trimmedParentId = parentBoardId.trimmingCharacters(in: .whitespacesAndNewlines)
        for childId in children {
            let trimmed = childId.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, trimmed != trimmedParentId, seen.insert(trimmed).inserted else { continue }
            ordered.append(trimmed)
        }
        return ordered
    }

    private func fetchTaskModel(id: String) -> TaskifyTask? {
        guard let ctx = modelContext else { return nil }
        let descriptor = FetchDescriptor<TaskifyTask>(
            predicate: #Predicate<TaskifyTask> { t in t.id == id }
        )
        return try? ctx.fetch(descriptor).first
    }

    private func fetchOrCreateBoard(boardId: String) -> TaskifyBoard {
        guard let ctx = modelContext else {
            return TaskifyBoard(id: boardId, name: "Unknown")
        }
        let descriptor = FetchDescriptor<TaskifyBoard>(
            predicate: #Predicate<TaskifyBoard> { b in b.id == boardId }
        )
        if let existing = try? ctx.fetch(descriptor).first {
            return existing
        }
        let board = TaskifyBoard(id: boardId, name: "Board")
        ctx.insert(board)
        try? ctx.save()
        return board
    }

    private func applyEditToModel(_ editVM: TaskEditViewModel, task: TaskifyTask) {
        task.title = editVM.title.trimmingCharacters(in: .whitespaces)
        task.note = editVM.note.isEmpty ? nil : editVM.note
        task.priority = editVM.priority.rawValue == 0 ? nil : editVM.priority.rawValue
        task.dueDateEnabled = editVM.dueDateEnabled
        task.dueTimeEnabled = editVM.dueTimeEnabled
        task.dueTimeZone = editVM.dueTimeEnabled ? editVM.dueTimeZone : nil
        task.dueISO = editVM.computedDueISO ?? ""
        task.column = editVM.location.columnId
        task.subtasksJSON = editVM.subtasksJSONString
        task.recurrenceJSON = editVM.recurrenceJSONString
    }

    private func handleIncomingTaskEvent(_ event: NostrEvent, boardId: String) {
        guard let ctx = modelContext else { return }
        guard let taskId = event.tagValue("d"), !taskId.isEmpty,
              let plaintext = try? decryptTaskPayload(event.content, boardId: boardId),
              let data = plaintext.data(using: .utf8),
              let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let status = event.tagValue("status")
        else { return }

        let descriptor = FetchDescriptor<TaskifyTask>(
            predicate: #Predicate<TaskifyTask> { t in t.id == taskId }
        )
        let existing = try? ctx.fetch(descriptor).first

        if let existing {
            // Clock-protected: skip older events
            if event.created_at < existing.createdAt { return }
            applyPayloadToModel(payload, status: status, task: existing, createdAt: event.created_at, colTag: event.tagValue("col"))
        } else {
            let task = TaskifyTask(id: taskId, boardId: boardId, title: payload["title"] as? String ?? "", completed: status == "done", deleted: status == "deleted", createdAt: event.created_at)
            applyPayloadToModel(payload, status: status, task: task, createdAt: event.created_at, colTag: event.tagValue("col"))
            ctx.insert(task)
        }
        try? ctx.save()
        _ = refreshActiveBoardItems()
    }

    private func applyPayloadToModel(_ payload: [String: Any], status: String, task: TaskifyTask, createdAt: Int, colTag: String?) {
        task.sourceBoardId = task.boardId
        task.boardName = boardName(boardId: task.boardId)
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
        task.createdAt = createdAt
        if payload.keys.contains("updatedAt") {
            task.updatedAt = stringField(payload["updatedAt"])
        } else {
            task.updatedAt = isoTimestamp(unixSeconds: createdAt)
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

    private func publishBoardMetadata(_ board: TaskifyBoard) async {
        guard let pool = relayPool else { return }
        do {
            let boardKeyInfo = try BoardKeyInfo(boardId: board.id)
            let bTag = boardTagHash(board.id)
            let childBoardIds = decodedStringArray(board.childrenJSON)
            let columns = decodedColumns(board.columnsJSON)
            let payload = BoardDefinitionPayload(
                name: board.name,
                kind: board.kind,
                clearCompletedDisabled: board.clearCompletedDisabled,
                columns: board.kind == "lists" ? columns : nil,
                listIndex: board.kind == "lists" || board.kind == "compound" ? board.indexCardEnabled : nil,
                children: board.kind == "compound" ? childBoardIds : nil,
                hideBoardNames: board.kind == "compound" ? board.hideChildBoardNames : nil,
                archived: board.archived,
                hidden: board.hidden,
                sortMode: board.sortMode,
                sortDirection: board.sortDirection,
                version: 1
            )
            guard let raw = BoardDefinitionCodec.encode(payload) else { return }
            let encrypted = try encryptTaskPayload(raw, boardId: board.id)
            var tags: [[String]] = [["d", bTag], ["b", bTag], ["k", board.kind], ["name", board.name]]
            if board.kind == "lists" {
                tags.append(contentsOf: columns.map { ["col", $0.id, $0.name] })
            }
            if board.kind == "compound" {
                tags.append(contentsOf: childBoardIds.map { ["ch", $0] })
            }
            if let sortMode = board.sortMode?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty {
                tags.append(["sort", sortMode, board.sortDirection ?? "asc"])
            }
            let unsigned = UnsignedNostrEvent(
                pubkey: boardKeyInfo.publicKeyHex,
                kind: TaskifyEventKind.boardDefinition.rawValue,
                tags: tags,
                content: encrypted
            )
            let event = try unsigned.sign(privateKeyBytes: boardKeyInfo.privateKeyBytes)
            await pool.publish(event: event)
            board.metadataCreatedAt = event.created_at
            try? modelContext?.save()
        } catch {
            lastError = "Board publish failed: \(error.localizedDescription)"
        }
    }

    /// Publish a task event to relays. Mirrors SyncEngine.publishTask().
    private func publishTask(_ task: TaskifyTask, status: String) async {
        guard let pool = relayPool else { return }
        do {
            let board = fetchBoardModel(id: task.boardId)
            if let board {
                await publishBoardMetadata(board)
            }
            let boardKeyInfo = try BoardKeyInfo(boardId: task.boardId)
            let payload = buildTaskPayload(task)
            let json = try JSONSerialization.data(withJSONObject: payload)
            let plaintext = String(data: json, encoding: .utf8)!
            let encrypted = try encryptTaskPayload(plaintext, boardId: task.boardId)
            let bTag = boardTagHash(task.boardId)
            let colTag = board?.kind == "week" ? "day" : (task.column ?? "")

            let unsigned = UnsignedNostrEvent(
                pubkey: boardKeyInfo.publicKeyHex,
                kind: 30301,
                tags: [["d", task.id], ["b", bTag], ["col", colTag], ["status", status]],
                content: encrypted
            )
            let event = try unsigned.sign(privateKeyBytes: boardKeyInfo.privateKeyBytes)
            await pool.publish(event: event)
            if status == "deleted" {
                let deletion = try taskDeletionEvent(taskId: task.id, boardKeyInfo: boardKeyInfo)
                await pool.publish(event: deletion)
            }
        } catch {
            lastError = "Publish failed: \(error.localizedDescription)"
        }
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
            "images": jsonField(task.imagesJSON),
            "documents": jsonField(task.documentsJSON),
            "subtasks": jsonField(task.subtasksJSON),
            "assignees": jsonField(task.assigneesJSON),
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

    private func taskDeletionEvent(taskId: String, boardKeyInfo: BoardKeyInfo) throws -> NostrEvent {
        let aTag = "30301:\(boardKeyInfo.publicKeyHex):\(taskId)"
        let unsigned = UnsignedNostrEvent(
            pubkey: boardKeyInfo.publicKeyHex,
            kind: TaskifyEventKind.deletion.rawValue,
            tags: [["a", aTag]],
            content: "Task deleted"
        )
        return try unsigned.sign(privateKeyBytes: boardKeyInfo.privateKeyBytes)
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

    private func isoTimestamp(unixSeconds: Int) -> String? {
        guard unixSeconds > 0 else { return nil }
        return ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: TimeInterval(unixSeconds)))
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

    // MARK: - Board management (edit/remove)

    /// Update a board's name and columns.
    public func updateBoard(
        boardId: String,
        name: String,
        columns: [BoardColumn],
        children: [String]? = nil,
        clearCompletedDisabled: Bool? = nil,
        indexCardEnabled: Bool? = nil,
        hideChildBoardNames: Bool? = nil,
        relayHints: [String]? = nil
    ) async {
        guard let ctx = modelContext else { return }
        let descriptor = FetchDescriptor<TaskifyBoard>(
            predicate: #Predicate<TaskifyBoard> { b in b.id == boardId }
        )
        guard let board = try? ctx.fetch(descriptor).first else { return }
        let trimmedName = normalizedBoardName(name) ?? board.name
        board.name = trimmedName
        if let colData = try? JSONEncoder().encode(columns),
           let colJSON = String(data: colData, encoding: .utf8) {
            board.columnsJSON = colJSON
        }
        if let relayHints {
            let normalized = normalizeRelayList(relayHints)
            board.relayHintsJSON = normalized.isEmpty ? nil : encodeJSONString(normalized)
        }
        if let children {
            let normalizedChildren = normalizeCompoundChildren(children, parentBoardId: boardId)
            board.childrenJSON = encodeJSONString(normalizedChildren)
            createCompoundChildStubs(normalizedChildren, relayHints: effectiveRelays(for: board))
        }
        if let clearCompletedDisabled {
            board.clearCompletedDisabled = clearCompletedDisabled
        }
        if let indexCardEnabled {
            board.indexCardEnabled = indexCardEnabled
        }
        if let hideChildBoardNames {
            board.hideChildBoardNames = hideChildBoardNames
        }
        try? ctx.save()

        // Update profile board entry
        if var prof = profile,
           let idx = prof.boards.firstIndex(where: { $0.id == boardId }) {
            prof.boards[idx].name = trimmedName
            profile = prof
            persistProfile(prof)
        }
        await rebuildRelayPool()
        await publishBoardMetadata(board)
        boardDefinitionsVersion &+= 1
        _ = refreshActiveBoardItems()
    }

    /// Update board sort preferences.
    public func updateBoardSort(boardId: String, sortMode: TaskSortMode, ascending: Bool) async {
        guard let ctx = modelContext else { return }
        let descriptor = FetchDescriptor<TaskifyBoard>(
            predicate: #Predicate<TaskifyBoard> { b in b.id == boardId }
        )
        guard let board = try? ctx.fetch(descriptor).first else { return }
        board.sortMode = sortMode.rawValue
        board.sortDirection = ascending ? "asc" : "desc"
        try? ctx.save()
        await publishBoardMetadata(board)
        boardDefinitionsVersion &+= 1
    }

    /// Fetch the stored sort mode for a board.
    public func boardSortPreferences(boardId: String) -> (mode: TaskSortMode, ascending: Bool) {
        guard let ctx = modelContext else { return (.manual, true) }
        let descriptor = FetchDescriptor<TaskifyBoard>(
            predicate: #Predicate<TaskifyBoard> { b in b.id == boardId }
        )
        guard let board = try? ctx.fetch(descriptor).first else { return (.manual, true) }
        let mode = TaskSortMode(rawValue: board.sortMode ?? "manual") ?? .manual
        let asc = board.sortDirection != "desc"
        return (mode, asc)
    }

    /// Fetch columns for a board from SwiftData.
    public func boardColumns(boardId: String) -> [BoardColumn] {
        guard let board = fetchBoardModel(id: boardId) else { return [] }
        return decodedColumns(board.columnsJSON)
    }

    /// Remove a board from the profile (does not delete relay data).
    public func removeBoard(boardId: String) async {
        guard var prof = profile else { return }
        prof.boards.removeAll { $0.id == boardId }
        profile = prof
        persistProfile(prof)

        // Clean up local SwiftData
        if let ctx = modelContext {
            let descriptor = FetchDescriptor<TaskifyBoard>(
                predicate: #Predicate<TaskifyBoard> { b in b.id == boardId }
            )
            if let board = try? ctx.fetch(descriptor).first {
                ctx.delete(board)
                try? ctx.save()
            }
        }
        await rebuildRelayPool()
        boardDefinitionsVersion &+= 1
        _ = refreshActiveBoardItems()
    }

    /// Update relay list and reconnect.
    public func updateRelays(_ relays: [String]) async {
        guard var prof = profile else { return }
        prof.relays = normalizeRelayList(relays)
        profile = prof
        persistProfile(prof)
        await rebuildRelayPool()
    }

    // MARK: - Contacts

    public func fetchContacts() -> [TaskifyContactRecord] {
        guard let ctx = modelContext else { return [] }
        let descriptor = FetchDescriptor<TaskifyContact>(
            sortBy: [SortDescriptor(\.updatedAt, order: .reverse)]
        )
        let contacts = (try? ctx.fetch(descriptor)) ?? []
        return contacts
            .map { $0.toRecord() }
            .sorted { lhs, rhs in
                let left = (contactPrimaryName(lhs) + "|" + (contactSubtitle(lhs) ?? "")).lowercased()
                let right = (contactPrimaryName(rhs) + "|" + (contactSubtitle(rhs) ?? "")).lowercased()
                return left < right
            }
    }

    public func fetchPublicFollows() -> [TaskifyPublicFollowRecord] {
        guard let ctx = modelContext else { return [] }
        let descriptor = FetchDescriptor<TaskifyPublicFollow>(
            sortBy: [SortDescriptor(\.updatedAt, order: .reverse)]
        )
        let follows = (try? ctx.fetch(descriptor)) ?? []
        return follows
            .map { $0.toRecord() }
            .sorted { lhs, rhs in
                let left = ((lhs.petname ?? lhs.nip05 ?? lhs.username ?? lhs.pubkey)).lowercased()
                let right = ((rhs.petname ?? rhs.nip05 ?? rhs.username ?? rhs.pubkey)).lowercased()
                return left < right
            }
    }

    public func loadNip05Checks() -> [String: Nip05CheckState] {
        guard let profile else { return [:] }
        return ContactPreferencesStore.loadNip05Checks(npub: profile.npub)
    }

    @discardableResult
    public func ensureNip05Verification(
        contactId: String,
        nip05: String?,
        npub: String?,
        contactUpdatedAt: Int? = nil
    ) async -> Nip05CheckState? {
        guard !contactId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let normalizedNip05 = normalizeNip05(nip05),
              let contactHex = normalizeNostrPubkeyHex(npub) else {
            return nil
        }

        let checks = loadNip05Checks()
        if let existing = checks[contactId],
           existing.nip05 == normalizedNip05,
           existing.npub == contactHex {
            if existing.status == .pending {
                return existing
            }
            let cachedUpdatedAt = existing.contactUpdatedAt
            let targetUpdatedAt = contactUpdatedAt
            if let cachedUpdatedAt {
                if targetUpdatedAt == nil || targetUpdatedAt ?? 0 <= cachedUpdatedAt {
                    return existing
                }
            } else if targetUpdatedAt == nil {
                return existing
            }
        }

        let now = Int(Date().timeIntervalSince1970 * 1000)
        let pendingState = Nip05CheckState(
            status: .pending,
            nip05: normalizedNip05,
            npub: contactHex,
            checkedAt: now,
            contactUpdatedAt: contactUpdatedAt
        )
        saveNip05Check(pendingState, for: contactId)

        let finalStatus: Nip05CheckStatus
        do {
            let resolution = try await Nip05Resolver.resolve(normalizedNip05)
            finalStatus = resolution.pubkey == contactHex ? .valid : .invalid
        } catch {
            finalStatus = .invalid
        }

        let resolvedState = Nip05CheckState(
            status: finalStatus,
            nip05: normalizedNip05,
            npub: contactHex,
            checkedAt: Int(Date().timeIntervalSince1970 * 1000),
            contactUpdatedAt: contactUpdatedAt
        )
        saveNip05Check(resolvedState, for: contactId)
        return resolvedState
    }

    @discardableResult
    public func setPublicFollow(
        contact: TaskifyContactRecord,
        followed: Bool,
        publish: Bool = true
    ) async -> Bool {
        guard let publicKeyHex = normalizeNostrPubkeyHex(contact.npub) else { return false }
        let relay = contact.relays
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first(where: { !$0.isEmpty })
        let username = sanitizeUsername(contact.username ?? "").nilIfEmpty
        let normalizedNip05 = normalizeNip05(contact.nip05)
        let timestampMs = Int(Date().timeIntervalSince1970 * 1000)

        var follows = fetchPublicFollows().filter { $0.pubkey != publicKeyHex }
        if followed {
            follows.append(TaskifyPublicFollowRecord(
                pubkey: publicKeyHex,
                relay: relay,
                petname: nil,
                username: username,
                nip05: normalizedNip05,
                updatedAt: timestampMs
            ))
        }
        persistPublicFollows(follows)

        if publish {
            _ = await publishContactsToNostr(silent: true)
        }
        return true
    }

    @discardableResult
    public func saveContact(_ draft: TaskifyContactDraft, publish: Bool = true) async -> TaskifyContactRecord? {
        guard let ctx = modelContext else { return nil }
        let timestampMs = Int(Date().timeIntervalSince1970 * 1000)

        let normalizedNpub: String
        if draft.npub.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            normalizedNpub = ""
        } else {
            guard let publicKeyHex = try? NostrIdentityService.normalizePublicKeyInput(draft.npub),
                  let npub = try? NostrIdentityService.encodeNpub(fromPublicKeyHex: publicKeyHex) else {
                lastError = "Unable to normalize contact pubkey."
                return nil
            }
            normalizedNpub = npub
        }

        let normalizedDraft = TaskifyContactDraft(
            id: draft.id,
            kind: normalizedNpub.isEmpty ? draft.kind : .nostr,
            name: draft.name,
            address: draft.address,
            paymentRequest: draft.paymentRequest,
            npub: normalizedNpub,
            username: draft.username,
            displayName: draft.displayName,
            nip05: draft.nip05,
            about: draft.about,
            picture: draft.picture,
            relays: normalizeRelayList(draft.relays),
            source: draft.source ?? .manual
        )

        let hasData =
            !normalizedDraft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
            !normalizedDraft.displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
            !sanitizeUsername(normalizedDraft.username).isEmpty ||
            !normalizedDraft.address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
            !normalizedDraft.paymentRequest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
            !normalizedDraft.npub.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
            normalizeNip05(normalizedDraft.nip05) != nil ||
            !normalizedDraft.about.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
            !normalizedDraft.picture.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        guard hasData else { return nil }

        let existing = findContactModel(id: normalizedDraft.id, npub: normalizedDraft.npub)
        let model: TaskifyContact
        if let existing {
            model = existing
        } else {
            model = TaskifyContact(
                id: normalizedDraft.id ?? makeContactId(),
                kind: normalizedDraft.kind,
                createdAt: timestampMs,
                updatedAt: timestampMs,
                source: normalizedDraft.source ?? .manual
            )
            ctx.insert(model)
        }
        model.apply(draft: normalizedDraft, timestampMs: timestampMs)
        try? ctx.save()
        contactsVersion &+= 1

        if publish {
            _ = await publishContactsToNostr(silent: true)
        }

        return model.toRecord()
    }

    @discardableResult
    public func deleteContact(id: String, publish: Bool = true) async -> Bool {
        guard let ctx = modelContext,
              let model = findContactModel(id: id, npub: nil) else { return false }
        ctx.delete(model)
        try? ctx.save()
        contactsVersion &+= 1
        removeNip05Check(contactId: id)
        if publish {
            _ = await publishContactsToNostr(silent: true)
        }
        return true
    }

    public func lookupContact(reference: String) async throws -> TaskifyContactDraft {
        let trimmed = reference.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw Nip05Error.invalidAddress
        }

        if let qrDraft = ContactShareContract.parseQRValue(trimmed) {
            let npub = qrDraft.npub.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !npub.isEmpty else { return qrDraft }
            return try await hydrateLookupDraft(npub: npub, relayHints: qrDraft.relays, fallback: qrDraft)
        }

        if let envelope = ContactShareContract.parseEnvelope(trimmed) {
            let fallback = TaskifyContactDraft(
                kind: .nostr,
                name: envelope.name ?? "",
                address: envelope.lud16 ?? "",
                npub: envelope.npub,
                username: envelope.username ?? "",
                displayName: envelope.displayName ?? "",
                nip05: envelope.nip05 ?? "",
                about: envelope.about ?? "",
                picture: envelope.picture ?? "",
                relays: envelope.relays,
                source: .sync
            )
            return try await hydrateLookupDraft(npub: envelope.npub, relayHints: envelope.relays, fallback: fallback)
        }

        if let publicKeyHex = try? NostrIdentityService.normalizePublicKeyInput(trimmed),
           let npub = try? NostrIdentityService.encodeNpub(fromPublicKeyHex: publicKeyHex) {
            return try await hydrateLookupDraft(npub: npub, relayHints: [], fallback: TaskifyContactDraft(kind: .nostr, npub: npub, source: .manual))
        }

        let resolution = try await Nip05Resolver.resolve(trimmed)
        let npub = try NostrIdentityService.encodeNpub(fromPublicKeyHex: resolution.pubkey)
        return try await hydrateLookupDraft(
            npub: npub,
            relayHints: resolution.relays,
            fallback: TaskifyContactDraft(kind: .nostr, npub: npub, nip05: resolution.nip05, relays: resolution.relays, source: .manual)
        )
    }

    @discardableResult
    public func syncContactsFromNostr(silent: Bool = false) async -> ContactSyncState {
        guard let pool = relayPool,
              let profile,
              let currentPubkeyHex = currentPublicKeyHex() else {
            let state = ContactSyncState(status: .error, message: "Sign in to sync contacts.", updatedAt: nil)
            contactSyncState = state
            return state
        }

        let relays = contactsRelayURLs()
        guard !relays.isEmpty else {
            let state = ContactSyncState(status: .error, message: "Add at least one relay to sync contacts.", updatedAt: nil)
            contactSyncState = state
            return state
        }

        if !silent {
            contactSyncState = ContactSyncState(status: .loading, message: "Syncing contacts…", updatedAt: contactSyncState.updatedAt)
        }

        let publicEvents = await pool.fetchEvents(filters: [[
            "kinds": [TaskifyEventKind.contacts.rawValue],
            "authors": [currentPubkeyHex],
            "limit": 1,
        ]], hardTimeoutMs: 12_000, eoseGraceMs: 250, inactivityMs: 2_000)

        let privateEvents = await pool.fetchEvents(filters: [[
            "kinds": [taskifyNip51ContactsKind],
            "authors": [currentPubkeyHex],
            "#d": [taskifyNip51ContactsDTag],
            "limit": 1,
        ]], hardTimeoutMs: 12_000, eoseGraceMs: 250, inactivityMs: 2_000)

        if let latestPublic = publicEvents.max(by: { $0.created_at < $1.created_at }) {
            let extracted = extractPublicFollows(from: latestPublic.tags)
            let enriched = await enrichPublicFollows(extracted, relays: relays)
            persistPublicFollows(enriched)
        }

        guard let latestPrivate = privateEvents.max(by: { $0.created_at < $1.created_at }) else {
            let state = ContactSyncState(
                status: .idle,
                message: "No private contacts found on relays yet.",
                updatedAt: ContactPreferencesStore.loadSyncMetadata(npub: profile.npub).lastUpdatedAt
            )
            contactSyncState = state
            return state
        }

        do {
            let items = try decryptNip51PrivateItems(
                latestPrivate.content,
                privateKeyHex: profile.nsecHex,
                publicKeyHex: currentPubkeyHex
            )
            let contacts = extractNip51PrivateContacts(items)
            let updatedAt = latestPrivate.created_at * 1000
            let incoming = contacts.compactMap { contact -> TaskifyContactRecord? in
                guard let npub = try? NostrIdentityService.encodeNpub(fromPublicKeyHex: contact.pubkey) else { return nil }
                return TaskifyContactRecord(
                    id: makeContactId(),
                    kind: .nostr,
                    name: contact.petname ?? "",
                    address: "",
                    paymentRequest: "",
                    npub: npub,
                    relays: contact.relayHint.map { [$0] } ?? [],
                    createdAt: updatedAt,
                    updatedAt: updatedAt,
                    source: .sync
                )
            }
            mergeSyncedContacts(incoming, envelopeUpdatedAt: updatedAt)
            let fingerprint = computeContactsFingerprint(fetchContacts())
            ContactPreferencesStore.saveSyncMetadata(
                ContactSyncMetadata(lastEventId: latestPrivate.id, lastUpdatedAt: updatedAt, fingerprint: fingerprint),
                npub: profile.npub
            )
            await refreshContactProfiles()
            let state = ContactSyncState(
                status: .success,
                message: "Synced \(incoming.count) contact\(incoming.count == 1 ? "" : "s")",
                updatedAt: updatedAt
            )
            contactSyncState = state
            return state
        } catch {
            let state = ContactSyncState(status: .error, message: error.localizedDescription, updatedAt: contactSyncState.updatedAt)
            contactSyncState = state
            return state
        }
    }

    @discardableResult
    public func publishContactsToNostr(silent: Bool = false) async -> ContactSyncState {
        guard let pool = relayPool,
              let profile,
              let currentPubkeyHex = currentPublicKeyHex(),
              let privateKeyBytes = Data(hexString: profile.nsecHex) else {
            let state = ContactSyncState(status: .error, message: "Sign in to sync contacts.", updatedAt: nil)
            contactSyncState = state
            return state
        }

        let relays = contactsRelayURLs()
        guard !relays.isEmpty else {
            let state = ContactSyncState(status: .error, message: "Add at least one relay to sync contacts.", updatedAt: nil)
            contactSyncState = state
            return state
        }

        if !silent {
            contactSyncState = ContactSyncState(status: .loading, message: "Publishing contacts…", updatedAt: contactSyncState.updatedAt)
        }

        do {
            let contacts = fetchContacts().filter { contactHasNpub($0) }
            let privateItems = buildNip51PrivateItems(contacts)
            let encrypted = try encryptNip51PrivateItems(privateItems, privateKeyHex: profile.nsecHex, publicKeyHex: currentPubkeyHex)
            let createdAt = Int(Date().timeIntervalSince1970)
            let privateEvent = try UnsignedNostrEvent(
                pubkey: currentPubkeyHex,
                kind: taskifyNip51ContactsKind,
                tags: [["d", taskifyNip51ContactsDTag]],
                content: encrypted,
                created_at: createdAt
            ).sign(privateKeyBytes: privateKeyBytes)
            await pool.publish(event: privateEvent)

            let publicFollowTags = buildPublicFollowTags(fetchPublicFollows())
            let publicEvent = try UnsignedNostrEvent(
                pubkey: currentPubkeyHex,
                kind: TaskifyEventKind.contacts.rawValue,
                tags: publicFollowTags,
                content: "",
                created_at: createdAt
            ).sign(privateKeyBytes: privateKeyBytes)
            await pool.publish(event: publicEvent)

            let updatedAt = privateEvent.created_at * 1000
            let fingerprint = computeContactsFingerprint(contacts)
            ContactPreferencesStore.saveSyncMetadata(
                ContactSyncMetadata(lastEventId: privateEvent.id, lastUpdatedAt: updatedAt, fingerprint: fingerprint),
                npub: profile.npub
            )
            let state = ContactSyncState(status: .success, message: "Contacts synced", updatedAt: updatedAt)
            contactSyncState = state
            return state
        } catch {
            let state = ContactSyncState(status: .error, message: error.localizedDescription, updatedAt: contactSyncState.updatedAt)
            contactSyncState = state
            return state
        }
    }

    public func refreshContactProfiles() async {
        guard let pool = relayPool else { return }
        let contacts = fetchContacts()
        let publicKeyHexes = Array(Set(contacts.compactMap { try? NostrIdentityService.normalizePublicKeyInput($0.npub) }))
        guard !publicKeyHexes.isEmpty else { return }
        let relays = contactsRelayURLs().isEmpty ? (profile?.relays ?? []) : contactsRelayURLs()
        let events = await pool.fetchEvents(filters: [[
            "kinds": [TaskifyEventKind.profileMetadata.rawValue],
            "authors": publicKeyHexes,
            "limit": max(publicKeyHexes.count * 3, 50),
        ]], hardTimeoutMs: 10_000, eoseGraceMs: 250, inactivityMs: 2_000)
        let latestByPubkey = Dictionary(grouping: events, by: \.pubkey).compactMapValues { group in
            group.max(by: { $0.created_at < $1.created_at })
        }
        guard !latestByPubkey.isEmpty, let ctx = modelContext else { return }

        var changed = false
        for contact in fetchContactModels() {
            guard let pubkeyHex = try? NostrIdentityService.normalizePublicKeyInput(contact.npub),
                  let event = latestByPubkey[pubkeyHex] else {
                continue
            }
            let profileMeta = parseProfileMetadata(content: event.content)
            let baseline = max(contact.updatedAt, contact.createdAt)
            let incomingUpdatedAt = event.created_at * 1000
            let isNewer = incomingUpdatedAt > baseline
            let shouldFill = contact.displayName == nil || contact.username == nil || contact.address.isEmpty || contact.nip05 == nil || contact.about == nil || contact.picture == nil || contact.name.isEmpty
            guard isNewer || shouldFill else { continue }

            var localChanged = false
            let preferredName = !profileMeta.displayName.isEmpty ? profileMeta.displayName : (!profileMeta.username.isEmpty ? profileMeta.username : contact.name)
            if (contact.source != .manual || contact.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty),
               !preferredName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               preferredName != contact.name {
                contact.name = preferredName
                localChanged = true
            }
            localChanged = applyProfileField(profileMeta.displayName, current: contact.displayName, allowReplace: isNewer) { contact.displayName = $0 } || localChanged
            localChanged = applyProfileField(sanitizeUsername(profileMeta.username), current: contact.username, allowReplace: isNewer) { contact.username = $0 } || localChanged
            localChanged = applyProfileField(profileMeta.lud16, current: contact.address, allowReplace: isNewer) { contact.address = $0 ?? "" } || localChanged
            localChanged = applyProfileField(normalizeNip05(profileMeta.nip05), current: contact.nip05, allowReplace: isNewer) { contact.nip05 = $0 } || localChanged
            localChanged = applyProfileField(profileMeta.about, current: contact.about, allowReplace: isNewer) { contact.about = $0 } || localChanged
            localChanged = applyProfileField(profileMeta.picture, current: contact.picture, allowReplace: isNewer) { contact.picture = $0 } || localChanged

            if localChanged {
                contact.updatedAt = isNewer ? incomingUpdatedAt : baseline
                changed = true
            }
        }

        if changed {
            try? ctx.save()
            contactsVersion &+= 1
        }

        let follows = fetchPublicFollowModels()
        var followsChanged = false
        for follow in follows {
            guard let event = latestByPubkey[follow.pubkey] else { continue }
            let meta = parseProfileMetadata(content: event.content)
            let updatedAt = event.created_at * 1000
            if (follow.username == nil || follow.updatedAt <= updatedAt) && !meta.username.isEmpty {
                follow.username = sanitizeUsername(meta.username)
                followsChanged = true
            }
            if (follow.nip05 == nil || follow.updatedAt <= updatedAt), let nip05 = normalizeNip05(meta.nip05) {
                follow.nip05 = nip05
                followsChanged = true
            }
            if followsChanged {
                follow.updatedAt = max(follow.updatedAt, updatedAt)
            }
        }
        if followsChanged {
            try? ctx.save()
            publicFollowsVersion &+= 1
        }

        _ = relays
    }

    @discardableResult
    public func loadMyProfileMetadata() async -> TaskifyProfileMetadata {
        guard let pool = relayPool, let currentPubkeyHex = currentPublicKeyHex() else {
            return myProfileMetadata
        }
        let relays = contactsRelayURLs()
        guard !relays.isEmpty else { return myProfileMetadata }
        let events = await pool.fetchEvents(filters: [[
            "kinds": [TaskifyEventKind.profileMetadata.rawValue],
            "authors": [currentPubkeyHex],
            "limit": 1,
        ]], hardTimeoutMs: 10_000, eoseGraceMs: 250, inactivityMs: 2_000)
        guard let latest = events.max(by: { $0.created_at < $1.created_at }) else {
            return myProfileMetadata
        }
        var metadata = parseProfileMetadata(content: latest.content)
        metadata.updatedAt = latest.created_at * 1000
        if let profile {
            ContactPreferencesStore.saveProfileMetadata(metadata, npub: profile.npub)
        }
        myProfileMetadata = metadata
        return metadata
    }

    @discardableResult
    public func publishMyProfileMetadata(_ metadata: TaskifyProfileMetadata) async -> ContactSyncState {
        guard let pool = relayPool,
              let profile,
              let currentPubkeyHex = currentPublicKeyHex(),
              let privateKeyBytes = Data(hexString: profile.nsecHex) else {
            let state = ContactSyncState(status: .error, message: "Sign in to publish your profile.", updatedAt: nil)
            contactSyncState = state
            return state
        }
        let relays = contactsRelayURLs()
        guard !relays.isEmpty else {
            let state = ContactSyncState(status: .error, message: "Add at least one relay to publish your profile.", updatedAt: nil)
            contactSyncState = state
            return state
        }
        do {
            let event = try UnsignedNostrEvent(
                pubkey: currentPubkeyHex,
                kind: TaskifyEventKind.profileMetadata.rawValue,
                tags: [],
                content: buildProfileMetadataContent(metadata)
            ).sign(privateKeyBytes: privateKeyBytes)
            await pool.publish(event: event)
            var stored = metadata
            stored.updatedAt = event.created_at * 1000
            ContactPreferencesStore.saveProfileMetadata(stored, npub: profile.npub)
            myProfileMetadata = stored
            let state = ContactSyncState(status: .success, message: "Profile saved", updatedAt: stored.updatedAt)
            contactSyncState = state
            return state
        } catch {
            let state = ContactSyncState(status: .error, message: error.localizedDescription, updatedAt: myProfileMetadata.updatedAt)
            contactSyncState = state
            return state
        }
    }

    public func contactShareValue(contactId: String) -> String? {
        guard let contact = findContactModel(id: contactId, npub: nil)?.toRecord() else { return nil }
        return ContactShareContract.buildQRValue(contact: contact)
    }

    public func contactShareEnvelope(contactId: String) -> String? {
        guard let contact = findContactModel(id: contactId, npub: nil)?.toRecord() else { return nil }
        return ContactShareContract.buildEnvelopeString(contact: contact, sender: currentSenderIdentity())
    }

    public func myContactShareValue() -> String? {
        guard let profile else { return nil }
        return ContactShareContract.buildQRValue(contact: myContactRecord(profile: profile))
    }

    public func myContactShareEnvelope() -> String? {
        guard let profile else { return nil }
        return ContactShareContract.buildEnvelopeString(contact: myContactRecord(profile: profile), sender: currentSenderIdentity())
    }

    private func currentSenderIdentity() -> (npub: String?, name: String?) {
        let senderName = myProfileMetadata.displayName.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
            ?? sanitizeUsername(myProfileMetadata.username).nilIfEmpty
            ?? profile?.name
        return (profile?.npub, senderName)
    }

    private func myContactRecord(profile: TaskifyProfile) -> TaskifyContactRecord {
        TaskifyContactRecord(
            id: "profile",
            kind: .nostr,
            name: myProfileMetadata.displayName.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
                ?? sanitizeUsername(myProfileMetadata.username).nilIfEmpty
                ?? profile.name,
            address: myProfileMetadata.lud16,
            paymentRequest: "",
            npub: profile.npub,
            username: myProfileMetadata.username.nilIfEmpty,
            displayName: myProfileMetadata.displayName.nilIfEmpty,
            nip05: myProfileMetadata.nip05.nilIfEmpty,
            about: myProfileMetadata.about.nilIfEmpty,
            picture: myProfileMetadata.picture.nilIfEmpty,
            relays: profile.relays,
            createdAt: myProfileMetadata.updatedAt ?? 0,
            updatedAt: myProfileMetadata.updatedAt ?? 0,
            source: .profile
        )
    }

    /// Returns the current profile (for views that need relay list, etc.).
    public var currentProfile: TaskifyProfile? { profile }

    // MARK: - Disconnect

    public func disconnect() async {
        await unsubscribe()
        await relayPool?.disconnect()
        relayPool = nil
    }
}

private extension String {
    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}
