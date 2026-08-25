import Foundation
import Observation
import Security
import TaskifyWatchShared
import WatchConnectivity
import WidgetKit

enum TaskifyWatchKeychainError: LocalizedError {
    case passcodeRequired
    case keychain(OSStatus)

    var errorDescription: String? {
        switch self {
        case .passcodeRequired:
            "Set a passcode on this Apple Watch before enabling independent sync."
        case .keychain(let status):
            "The Nostr identity could not be stored securely (\(status))."
        }
    }
}

enum TaskifyWatchDictationError: LocalizedError {
    case phoneUnavailable
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .phoneUnavailable:
            "Connect this Watch to the internet or open Taskify on your iPhone."
        case .invalidResponse:
            "Taskify couldn't interpret that. Try saying it another way."
        }
    }
}

private struct TaskifyWatchDirectMutation {
    let event: TaskifyWatchNostrEvent
    let task: TaskifyWatchTask?
    let relayURLs: [String]
}

/// Stores the Nostr private key only in the Watch's system Keychain. This protection class does
/// not sync, is not backed up, is unavailable while locked, and is destroyed if the Watch
/// passcode is removed.
struct TaskifyWatchIdentityStore {
    private let service = "solife.me.Taskify.Native.watchkitapp"
    private let account = "nostr-identity-private-key-v1"

    func save(_ privateKey: Data) throws {
        guard privateKey.count == 32 else {
            throw TaskifyWatchTransfer.TransferError.invalidPrivateKey
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: privateKey,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
        ]

        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else {
            throw map(updateStatus)
        }

        var item = query
        attributes.forEach { item[$0.key] = $0.value }
        let addStatus = SecItemAdd(item as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw map(addStatus) }
    }

    func containsIdentity() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
            kSecReturnData as String: false,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        return SecItemCopyMatching(query as CFDictionary, nil) == errSecSuccess
    }

    func load() throws -> Data {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data, data.count == 32 else {
            throw map(status)
        }
        return data
    }

    private func map(_ status: OSStatus) -> TaskifyWatchKeychainError {
        if status == errSecAuthFailed || status == errSecInteractionNotAllowed {
            return .passcodeRequired
        }
        return .keychain(status)
    }
}

@Observable
@MainActor
final class TaskifyWatchAppModel: NSObject {
    private(set) var snapshot = TaskifyWatchSnapshot()
    private(set) var isProvisioned = false
    private(set) var statusMessage = "Open Taskify on your iPhone to authorize this Watch."
    private(set) var pendingCompletionIDs: Set<String> = []
    private(set) var activeQuickAddBoardID: String?

    @ObservationIgnored private let identityStore = TaskifyWatchIdentityStore()
    @ObservationIgnored private let cacheURL: URL
    @ObservationIgnored private let commandCacheURL: URL
    @ObservationIgnored private let profileCacheURL: URL
    @ObservationIgnored private let independentClient = TaskifyWatchIndependentClient()
    @ObservationIgnored private var pendingCommands: [TaskifyWatchCommand] = []
    @ObservationIgnored private var immediateCommandIDs: Set<String> = []
    @ObservationIgnored private var directSyncCommandIDs: Set<String> = []
    @ObservationIgnored private var independentProfile: TaskifyWatchIndependentProfile?
    @ObservationIgnored private var requestedInitialSetupNavigation = false
    @ObservationIgnored private var latestPhoneSnapshotGeneratedAt = Date.distantPast

    override init() {
        let supportURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        cacheURL = supportURL.appendingPathComponent("taskify-watch-snapshot-v1.json")
        commandCacheURL = supportURL.appendingPathComponent("taskify-watch-commands-v1.json")
        profileCacheURL = supportURL.appendingPathComponent("taskify-watch-independent-profile-v1.json")
        super.init()
        isProvisioned = identityStore.containsIdentity()
        loadIndependentProfile()
        loadCachedSnapshot()
        loadPendingCommands()
        activateConnectivity()
        if isProvisioned {
            statusMessage = independentProfile == nil
                ? "Open Taskify on iPhone once to upgrade independent sync."
                : "Independent sync ready"
        }
    }

    var todayTasks: [TaskifyWatchTask] {
        visible(snapshot.todayTasks())
    }

    var upcomingTasks: [TaskifyWatchTask] {
        visible(snapshot.upcomingTasks())
    }

    func tasks(for boardID: String) -> [TaskifyWatchTask] {
        visible(snapshot.tasks(for: boardID))
    }

    func openTaskCount(for boardID: String) -> Int {
        guard let board = snapshot.boards.first(where: { $0.id == boardID }) else { return 0 }
        let pendingCount = snapshot.tasks.lazy.filter {
            $0.boardID == boardID && self.pendingCompletionIDs.contains($0.id)
        }.count
        return max(0, board.openTaskCount - pendingCount)
    }

    var quickAddBoardID: String? {
        activeQuickAddBoardID ?? snapshot.selectedBoardID ?? snapshot.boards.first?.id
    }

    func boardName(for boardID: String?) -> String {
        guard let boardID,
              let board = snapshot.boards.first(where: { $0.id == boardID }) else {
            return "No board available"
        }
        return board.name
    }

    func setActiveQuickAddBoardID(_ boardID: String?) {
        activeQuickAddBoardID = boardID
    }

    func requestInitialSetupNavigation() {
        guard !isProvisioned,
              !requestedInitialSetupNavigation,
              WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated else { return }

        requestedInitialSetupNavigation = true
        statusMessage = "Open Taskify on your iPhone. Watch authorization will open automatically."
        let request = TaskifyWatchTransfer.setupNavigationRequest
        if session.isReachable {
            session.sendMessage(request) { _ in
                // The iPhone accepted the navigation request. Provisioning still requires the
                // explicit confirmation button on the phone.
            } errorHandler: { [weak self] _ in
                Task { @MainActor in
                    self?.queueInitialSetupNavigation(request, using: session)
                }
            }
        } else {
            queueInitialSetupNavigation(request, using: session)
        }
    }

    private func queueInitialSetupNavigation(
        _ request: [String: Any],
        using session: WCSession
    ) {
        let alreadyQueued = session.outstandingUserInfoTransfers.contains {
            TaskifyWatchTransfer.isSetupNavigationRequest($0.userInfo)
        }
        guard !alreadyQueued else { return }
        session.transferUserInfo(request)
    }

    func completeTask(_ taskID: String) {
        guard snapshot.tasks.contains(where: { $0.id == taskID }),
              !pendingCompletionIDs.contains(taskID) else { return }
        let command = TaskifyWatchCommand(kind: .completeTask, taskID: taskID)
        pendingCommands.append(command)
        pendingCompletionIDs.insert(taskID)
        persistPendingCommands()
        persistWidgetSnapshot()
        deliver(command)
        beginDirectSync(command)
    }

    @discardableResult
    func addTask(_ input: String, boardID requestedBoardID: String?, usingTaskifyVoice: Bool) -> Bool {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, let boardID = requestedBoardID ?? quickAddBoardID else {
            statusMessage = "Choose a board before adding a task."
            return false
        }
        let command = TaskifyWatchCommand(
            kind: usingTaskifyVoice ? .processVoiceTranscript : .createTask,
            title: usingTaskifyVoice ? nil : value,
            boardID: boardID,
            transcript: usingTaskifyVoice ? value : nil
        )
        pendingCommands.append(command)
        persistPendingCommands()
        statusMessage = usingTaskifyVoice ? "Sending to Taskify Voice…" : "Adding task…"
        deliver(command)
        beginDirectSync(command)
        return true
    }

    func previewVoiceTasks(
        transcript input: String,
        boardID: String
    ) async throws -> TaskifyWatchVoicePreview {
        let transcript = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !transcript.isEmpty else {
            throw TaskifyWatchDictationError.invalidResponse
        }
        if let profile = independentProfile,
           !profile.publicKeyNpub.isEmpty,
           let privateKey = try? identityStore.load() {
            do {
                return try await independentClient.interpretVoice(
                    transcript: transcript,
                    boardID: boardID,
                    profile: profile,
                    privateKey: privateKey
                )
            } catch {
                // A reachable iPhone remains a seamless fallback while the Watch service or its
                // network route is temporarily unavailable.
            }
        }
        guard WCSession.isSupported(),
              WCSession.default.activationState == .activated,
              WCSession.default.isReachable else {
            throw TaskifyWatchDictationError.phoneUnavailable
        }
        let request = TaskifyWatchVoicePreviewRequest(
            transcript: transcript,
            boardID: boardID
        )
        let data = try TaskifyWatchTransfer.encode(request)
        return try await withCheckedThrowingContinuation { continuation in
            WCSession.default.sendMessageData(data) { replyData in
                do {
                    let preview = try TaskifyWatchTransfer.decodeVoicePreview(replyData)
                    guard preview.requestID == request.id else {
                        throw TaskifyWatchDictationError.invalidResponse
                    }
                    continuation.resume(returning: preview)
                } catch {
                    continuation.resume(throwing: TaskifyWatchDictationError.invalidResponse)
                }
            } errorHandler: { _ in
                continuation.resume(throwing: TaskifyWatchDictationError.phoneUnavailable)
            }
        }
    }

    @discardableResult
    func addVoiceTasks(_ tasks: [TaskifyWatchVoiceDraft], boardID: String) -> Bool {
        guard !tasks.isEmpty else { return false }
        let command = TaskifyWatchCommand(
            kind: .createVoiceTasks,
            boardID: boardID,
            voiceTasks: tasks
        )
        pendingCommands.append(command)
        persistPendingCommands()
        statusMessage = tasks.count == 1 ? "Adding task…" : "Adding \(tasks.count) tasks…"
        deliver(command)
        beginDirectSync(command)
        return true
    }

    /// Refreshes encrypted Taskify task records through the Watch HTTPS transport. This works
    /// over the Watch's own Wi-Fi/cellular route and does not require a reachable iPhone.
    func refreshLatestData(forceComplicationReload: Bool = false) async {
        // Apply the phone projection first, then let the relay's latest replaceable events win.
        // Running these concurrently can allow a delayed phone reply to overwrite a newer edit
        // fetched directly from a web client.
        await requestLatestSnapshotFromPhone()
        await refreshFromRelays()
        if forceComplicationReload {
            reloadComplicationTimelines()
        }
    }

    func refreshFromRelays() async {
        guard isProvisioned,
              !snapshot.boards.isEmpty,
              let profile = independentProfile,
              !directSyncCommandIDs.contains("_refresh"),
              let privateKey = try? identityStore.load() else { return }
        directSyncCommandIDs.insert("_refresh")
        defer { directSyncCommandIDs.remove("_refresh") }

        do {
            let events = try await independentClient.fetchTasks(
                boards: snapshot.boards,
                profile: profile,
                privateKey: privateKey
            )
            mergeRelayEvents(events)
            statusMessage = pendingCommands.isEmpty ? "Independent sync up to date" : "Watch changes waiting for iPhone"
        } catch {
            // Cached tasks and the phone transport remain fully usable when the independent
            // service or every configured relay is temporarily unavailable.
            if pendingCommands.isEmpty {
                statusMessage = "Showing saved tasks — relay refresh will retry."
            }
        }
    }

    private func beginDirectSync(_ command: TaskifyWatchCommand) {
        if WCSession.isSupported(),
           WCSession.default.activationState == .activated,
           WCSession.default.isReachable {
            return
        }
        guard independentProfile != nil,
              directSyncCommandIDs.insert(command.id).inserted else { return }
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.directSyncCommandIDs.remove(command.id) }
            await self.publishDirectly(command)
        }
    }

    private func publishDirectly(_ command: TaskifyWatchCommand) async {
        guard let profile = independentProfile,
              let privateKey = try? identityStore.load(),
              let mutations = try? directMutations(for: command),
              !mutations.isEmpty else { return }

        var published: [TaskifyWatchDirectMutation] = []
        for mutation in mutations {
            do {
                try await independentClient.publish(
                    mutation.event,
                    relayURLs: mutation.relayURLs,
                    profile: profile,
                    privateKey: privateKey
                )
                published.append(mutation)
            } catch {
                // Keep the idempotent command in the durable phone queue. A later direct retry or
                // iPhone reconciliation can safely publish the same stable task identifier.
            }
        }
        guard !published.isEmpty else { return }
        applyDirectMutations(published)
        if published.count == mutations.count {
            statusMessage = command.kind == .completeTask
                ? "Completed directly from Watch"
                : (published.count == 1 ? "Task synced directly" : "Tasks synced directly")
        } else {
            statusMessage = "Some Watch changes synced; the rest are safely queued."
        }
    }

    private func directMutations(
        for command: TaskifyWatchCommand
    ) throws -> [TaskifyWatchDirectMutation] {
        guard let profile = independentProfile else { return [] }
        switch command.kind {
        case .completeTask:
            guard let taskID = command.taskID,
                  let task = snapshot.tasks.first(where: { $0.id == taskID }),
                  let board = snapshot.boards.first(where: { $0.id == task.boardID }),
                  let boardNostrID = task.nostrBoardID ?? board.nostrBoardID,
                  let originalPayload = task.syncPayload else { return [] }
            let createdAt = max(Int(Date().timeIntervalSince1970), (task.nostrUpdatedAt ?? 0) + 1)
            let completedAt = taskifyISODate(Date())
            let payload = try updatingPayload(originalPayload, values: [
                "completedAt": completedAt,
                "completedBy": profile.publicKeyHex,
                "lastEditedBy": profile.publicKeyHex,
            ])
            let event = try TaskifyWatchNostrCrypto.taskEvent(
                taskID: task.id,
                boardID: boardNostrID,
                columnTag: board.kind == "week" ? "day" : (task.columnID ?? board.defaultColumnID ?? ""),
                status: "done",
                payload: payload,
                createdAt: createdAt
            )
            return [TaskifyWatchDirectMutation(
                event: event,
                task: nil,
                relayURLs: normalizedRelays(task.relayURLs ?? board.relayURLs ?? profile.relayURLs)
            )]

        case .createTask:
            guard let title = command.title else { return [] }
            return try directCreationMutations(
                command: command,
                drafts: [TaskifyWatchVoiceDraft(title: title)]
            )

        case .createVoiceTasks:
            return try directCreationMutations(command: command, drafts: command.voiceTasks ?? [])

        case .processVoiceTranscript:
            // This legacy command is interpreted by the iPhone. Current Watch UI converts
            // dictation into createVoiceTasks through the independent voice endpoint first.
            return []
        }
    }

    private func directCreationMutations(
        command: TaskifyWatchCommand,
        drafts: [TaskifyWatchVoiceDraft]
    ) throws -> [TaskifyWatchDirectMutation] {
        guard let boardID = command.boardID,
              let board = snapshot.boards.first(where: { $0.id == boardID }),
              let boardNostrID = board.nostrBoardID,
              let profile = independentProfile else { return [] }
        let relays = normalizedRelays(board.relayURLs ?? profile.relayURLs)
        guard !relays.isEmpty else { return [] }

        return try drafts.enumerated().compactMap { index, draft -> TaskifyWatchDirectMutation? in
            let title = draft.title.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { return nil }
            let stableTaskID = "watch-\(command.id)-\(index)"
            if snapshot.tasks.contains(where: { $0.id == stableTaskID }) { return nil }

            let parsedDueDate = draft.dueISO.flatMap(taskifyParseISODate)
            let dueDate = board.kind == "week" ? (parsedDueDate ?? Date()) : parsedDueDate
            let columnID = board.kind == "week"
                ? taskifyWeekdayID(for: dueDate ?? Date())
                : board.defaultColumnID
            let created = Date()
            let order = (snapshot.tasks
                .filter { $0.boardID == board.id && $0.columnID == columnID }
                .map(\.order)
                .min() ?? 0) - 1
            let payload = try newTaskPayload(
                id: stableTaskID,
                draft: draft,
                dueDate: dueDate,
                profile: profile,
                createdAt: created
            )
            let eventCreatedAt = Int(created.timeIntervalSince1970)
            let event = try TaskifyWatchNostrCrypto.taskEvent(
                taskID: stableTaskID,
                boardID: boardNostrID,
                columnTag: board.kind == "week" ? "day" : (columnID ?? ""),
                status: "open",
                payload: payload,
                createdAt: eventCreatedAt
            )
            let task = TaskifyWatchTask(
                id: stableTaskID,
                title: title,
                boardID: board.id,
                boardName: board.name,
                columnName: board.kind == "week" ? taskifyWeekdayName(for: dueDate ?? created) : nil,
                dueDate: dueDate,
                dueTimeEnabled: false,
                priority: draft.priority,
                order: order,
                columnID: columnID,
                nostrBoardID: boardNostrID,
                relayURLs: relays,
                syncPayload: payload,
                nostrUpdatedAt: eventCreatedAt
            )
            return TaskifyWatchDirectMutation(event: event, task: task, relayURLs: relays)
        }
    }

    private func newTaskPayload(
        id: String,
        draft: TaskifyWatchVoiceDraft,
        dueDate: Date?,
        profile: TaskifyWatchIndependentProfile,
        createdAt: Date
    ) throws -> Data {
        var payload: [String: Any] = [
            "title": draft.title.trimmingCharacters(in: .whitespacesAndNewlines),
            "createdAt": Int64(createdAt.timeIntervalSince1970 * 1_000),
            "createdBy": profile.publicKeyHex,
            "lastEditedBy": profile.publicKeyHex,
            "dueDateEnabled": dueDate != nil,
            "dueTimeEnabled": false,
        ]
        if let dueDate { payload["dueISO"] = taskifyISODate(dueDate) }
        if let note = draft.notes, !note.isEmpty { payload["note"] = note }
        if let priority = draft.priority { payload["priority"] = priority }
        let subtasks = (draft.subtasks ?? []).enumerated().compactMap { index, raw -> [String: Any]? in
            let title = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { return nil }
            return ["id": "\(id)-subtask-\(index)", "title": title, "completed": false]
        }
        if !subtasks.isEmpty { payload["subtasks"] = subtasks }
        return try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys, .withoutEscapingSlashes])
    }

    private func updatingPayload(_ data: Data, values: [String: Any]) throws -> Data {
        guard var payload = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw TaskifyWatchNostrCryptoError.invalidPayload
        }
        for (key, value) in values { payload[key] = value }
        return try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys, .withoutEscapingSlashes])
    }

    private func applyDirectMutations(_ mutations: [TaskifyWatchDirectMutation]) {
        let createdTasks = mutations.compactMap(\.task)
        guard !createdTasks.isEmpty else { return }
        var tasks = snapshot.tasks
        for task in createdTasks where !tasks.contains(where: { $0.id == task.id }) {
            tasks.append(task)
        }
        replaceSnapshot(tasks: tasks, generatedAt: Date())
    }

    private func mergeRelayEvents(_ events: [TaskifyWatchNostrEvent]) {
        let boardPairs: [(String, TaskifyWatchBoard)] = snapshot.boards.compactMap { board in
            guard let boardID = board.nostrBoardID,
                  let author = try? TaskifyWatchNostrCrypto.boardPublicKeyHex(for: boardID) else {
                return nil
            }
            return (author, board)
        }
        let boardByAuthor = Dictionary(uniqueKeysWithValues: boardPairs)
        var latestByTaskID: [String: (TaskifyWatchNostrEvent, TaskifyWatchBoard)] = [:]
        for event in events {
            guard let taskID = event.firstTagValue(named: "d"),
                  let board = boardByAuthor[event.publicKey.lowercased()] else { continue }
            if let current = latestByTaskID[taskID], current.0.createdAt >= event.createdAt { continue }
            latestByTaskID[taskID] = (event, board)
        }

        var tasks = snapshot.tasks
        for (taskID, pair) in latestByTaskID {
            let event = pair.0
            let board = pair.1
            let existingIndex = tasks.firstIndex { $0.id == taskID }
            if let existingIndex,
               (tasks[existingIndex].nostrUpdatedAt ?? 0) > event.createdAt {
                continue
            }
            let status = event.firstTagValue(named: "status")
            if status == "done" || status == "deleted" {
                if let existingIndex { tasks.remove(at: existingIndex) }
                continue
            }
            guard let decoded = decodeRelayTask(event, board: board, existing: existingIndex.map { tasks[$0] }) else {
                continue
            }
            if let existingIndex { tasks[existingIndex] = decoded } else { tasks.append(decoded) }
        }
        replaceSnapshot(tasks: tasks, generatedAt: Date())
    }

    private func decodeRelayTask(
        _ event: TaskifyWatchNostrEvent,
        board: TaskifyWatchBoard,
        existing: TaskifyWatchTask?
    ) -> TaskifyWatchTask? {
        guard let boardNostrID = board.nostrBoardID,
              let payload = try? TaskifyWatchNostrCrypto.decryptTaskPayload(event, boardID: boardNostrID),
              let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
              let title = (object["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !title.isEmpty,
              let taskID = event.firstTagValue(named: "d") else { return nil }
        let dueDate = (object["dueISO"] as? String).flatMap(taskifyParseISODate)
        let columnID = board.kind == "week"
            ? taskifyWeekdayID(for: dueDate ?? Date())
            : event.firstTagValue(named: "col")
        let number = object["priority"] as? NSNumber
        return TaskifyWatchTask(
            id: taskID,
            title: title,
            boardID: board.id,
            boardName: board.name,
            columnName: board.kind == "week" ? taskifyWeekdayName(for: dueDate ?? Date()) : existing?.columnName,
            dueDate: (object["dueDateEnabled"] as? Bool) == false ? nil : dueDate,
            dueTimeEnabled: object["dueTimeEnabled"] as? Bool ?? false,
            priority: number?.intValue,
            order: existing?.order ?? 0,
            columnID: columnID,
            nostrBoardID: boardNostrID,
            relayURLs: board.relayURLs,
            syncPayload: payload,
            nostrUpdatedAt: event.createdAt
        )
    }

    private func replaceSnapshot(tasks: [TaskifyWatchTask], generatedAt: Date) {
        let boards = snapshot.boards.map { board in
            TaskifyWatchBoard(
                id: board.id,
                name: board.name,
                openTaskCount: tasks.lazy.filter { $0.boardID == board.id }.count,
                kind: board.kind,
                nostrBoardID: board.nostrBoardID,
                relayURLs: board.relayURLs,
                defaultColumnID: board.defaultColumnID
            )
        }
        snapshot = TaskifyWatchSnapshot(
            tasks: tasks,
            boards: boards,
            selectedBoardID: snapshot.selectedBoardID,
            generatedAt: generatedAt,
            acknowledgedCommandIDs: snapshot.acknowledgedCommandIDs
        )
        persistSnapshot()
    }

    private func normalizedRelays(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.compactMap { value in
            let normalized = value.trimmingCharacters(in: CharacterSet(charactersIn: " /"))
            guard normalized.hasPrefix("wss://"), seen.insert(normalized).inserted else { return nil }
            return normalized
        }
    }

    private func taskifyISODate(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }

    private func taskifyParseISODate(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        return ISO8601DateFormatter().date(from: value)
    }

    private func taskifyWeekdayID(for date: Date) -> String {
        switch Calendar.current.component(.weekday, from: date) {
        case 1: "sunday"
        case 2: "monday"
        case 3: "tuesday"
        case 4: "wednesday"
        case 5: "thursday"
        case 6: "friday"
        default: "saturday"
        }
    }

    private func taskifyWeekdayName(for date: Date) -> String {
        switch Calendar.current.component(.weekday, from: date) {
        case 1: "Sun"
        case 2: "Mon"
        case 3: "Tue"
        case 4: "Wed"
        case 5: "Thu"
        case 6: "Fri"
        default: "Sat"
        }
    }

    private func visible(_ tasks: [TaskifyWatchTask]) -> [TaskifyWatchTask] {
        tasks.filter { !pendingCompletionIDs.contains($0.id) }
    }

    private func activateConnectivity() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
        apply(applicationContext: session.receivedApplicationContext)
    }

    /// Pulls the current projection while both apps are reachable instead of relying solely on
    /// application-context delivery. This is especially important after the Watch app has been
    /// suspended: WatchConnectivity may wake it with an older cached context before delivering
    /// the replacement context.
    private func requestLatestSnapshotFromPhone() async {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated, session.isReachable else { return }
        await withCheckedContinuation { continuation in
            session.sendMessage(TaskifyWatchTransfer.snapshotRequest) { [weak self] reply in
                Task { @MainActor in
                    self?.apply(applicationContext: reply)
                    continuation.resume()
                }
            } errorHandler: { _ in
                // Independent relay refresh and the queued application context remain available.
                continuation.resume()
            }
        }
    }

    private func retryPendingCommands() {
        for command in pendingCommands {
            deliver(command)
            beginDirectSync(command)
        }
    }

    private func deliver(_ command: TaskifyWatchCommand) {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated,
              let data = try? TaskifyWatchTransfer.encode(command) else { return }

        if session.isReachable, immediateCommandIDs.insert(command.id).inserted {
            session.sendMessageData(data) { [weak self] replyData in
                Task { @MainActor in
                    guard let self else { return }
                    self.immediateCommandIDs.remove(command.id)
                    guard let receipt = try? TaskifyWatchTransfer.decodeCommandReceipt(replyData),
                          receipt.commandID == command.id else {
                        self.queueBackgroundDelivery(command, data: data)
                        self.beginDirectSync(command)
                        return
                    }
                    self.apply(snapshot: receipt.snapshot)
                    self.finish(commandID: command.id)
                }
            } errorHandler: { [weak self] _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.immediateCommandIDs.remove(command.id)
                    self.queueBackgroundDelivery(command, data: data)
                    self.beginDirectSync(command)
                }
            }
        } else if !session.isReachable {
            queueBackgroundDelivery(command, data: data)
        }
    }

    private func queueBackgroundDelivery(_ command: TaskifyWatchCommand, data: Data) {
        let session = WCSession.default
        let alreadyQueued = session.outstandingUserInfoTransfers.contains { transfer in
            guard let queuedData = transfer.userInfo[TaskifyWatchTransfer.commandDataKey] as? Data,
                  let queued = try? TaskifyWatchTransfer.decodeCommand(queuedData) else { return false }
            return queued.id == command.id
        }
        guard !alreadyQueued else { return }
        session.transferUserInfo([TaskifyWatchTransfer.commandDataKey: data])
        switch command.kind {
        case .completeTask:
            statusMessage = "Completion saved — it will sync when the iPhone is available."
        case .createTask:
            statusMessage = "Task saved — it will be added when the iPhone is available."
        case .createVoiceTasks:
            statusMessage = "Dictated tasks saved — they will be added when the iPhone is available."
        case .processVoiceTranscript:
            statusMessage = "Voice request saved — the iPhone will process it when available."
        }
    }

    private func finish(commandID: String) {
        let completedKind = pendingCommands.first(where: { $0.id == commandID })?.kind
        pendingCommands.removeAll { $0.id == commandID }
        refreshPendingCompletionIDs()
        persistPendingCommands()
        if pendingCommands.isEmpty {
            statusMessage = completedKind == .completeTask ? "Tasks are up to date" : "Task added"
        } else {
            statusMessage = "Waiting to sync Watch changes"
        }
    }

    private func acceptProvisioning(_ data: Data) throws -> Data {
        let payload = try TaskifyWatchTransfer.decodeProvisioningPayload(data)
        // Reject a malformed/mismatched envelope before it can replace the device-only key.
        _ = try TaskifyWatchNostrCrypto.requestAuthentication(
            privateKey: payload.privateKey,
            publicKeyHex: payload.publicKeyHex,
            body: Data(),
            timestamp: 0
        )
        // The only durable write of private material is this Keychain call. The decoded envelope
        // goes out of scope immediately after the receipt is produced.
        try identityStore.save(payload.privateKey)
        let npub = payload.publicKeyNpub?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        independentProfile = TaskifyWatchIndependentProfile(
            publicKeyHex: payload.publicKeyHex,
            publicKeyNpub: npub,
            relayURLs: payload.relayURLs
        )
        try persistIndependentProfile()
        isProvisioned = true
        sessionSetupTransfers().forEach { $0.cancel() }
        apply(snapshot: payload.snapshot)
        statusMessage = npub.isEmpty ? "Secure account stored" : "Independent sync ready"
        return try TaskifyWatchTransfer.encode(
            TaskifyWatchProvisioningReceipt(publicKeyHex: payload.publicKeyHex)
        )
    }

    private func apply(applicationContext: [String: Any]) {
        guard let data = applicationContext[TaskifyWatchTransfer.snapshotDataKey] as? Data,
              let received = try? TaskifyWatchTransfer.decodeConnectivitySnapshot(data) else { return }
        apply(snapshot: received)
    }

    private func apply(snapshot received: TaskifyWatchSnapshot) {
        // `generatedAt` is a cache timestamp, not a cross-device causal revision. A relay refresh
        // performed on Watch can legitimately have a later wall-clock time than an authoritative
        // iPhone snapshot that arrives afterward. Rejecting that phone state leaves the Watch
        // permanently stale until an even newer phone mutation occurs. Compare only against the
        // last phone projection instead, which still prevents delayed WatchConnectivity payloads
        // from rolling back a newer phone projection.
        guard received.generatedAt >= latestPhoneSnapshotGeneratedAt else { return }
        latestPhoneSnapshotGeneratedAt = received.generatedAt
        snapshot = received
        let acknowledged = Set(received.acknowledgedCommandIDs ?? [])
        if !acknowledged.isEmpty {
            let acknowledgedKinds = Set(
                pendingCommands.lazy
                    .filter { acknowledged.contains($0.id) }
                    .map(\.kind)
            )
            pendingCommands.removeAll { acknowledged.contains($0.id) }
            refreshPendingCompletionIDs()
            persistPendingCommands()
            if pendingCommands.isEmpty {
                statusMessage = acknowledgedKinds.contains(.createTask) ||
                    acknowledgedKinds.contains(.createVoiceTasks) ||
                    acknowledgedKinds.contains(.processVoiceTranscript)
                    ? "Task added"
                    : "Tasks are up to date"
            }
        }
        persistSnapshot()
    }

    private func loadIndependentProfile() {
        guard let data = try? Data(contentsOf: profileCacheURL),
              let profile = try? JSONDecoder().decode(TaskifyWatchIndependentProfile.self, from: data),
              profile.publicKeyHex.count == 64 else { return }
        independentProfile = profile
    }

    private func persistIndependentProfile() throws {
        guard let independentProfile else { return }
        try FileManager.default.createDirectory(
            at: profileCacheURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try JSONEncoder().encode(independentProfile).write(
            to: profileCacheURL,
            options: [.atomic, .completeFileProtection]
        )
    }

    private func loadCachedSnapshot() {
        guard let data = try? Data(contentsOf: cacheURL),
              let cached = try? TaskifyWatchTransfer.decodeSnapshot(data) else { return }
        snapshot = cached
        persistWidgetSnapshot()
    }

    private func loadPendingCommands() {
        guard let data = try? Data(contentsOf: commandCacheURL),
              let cached = try? JSONDecoder().decode([TaskifyWatchCommand].self, from: data) else { return }
        let oldestRetainedDate = Date().addingTimeInterval(-30 * 24 * 60 * 60)
        pendingCommands = cached.filter { $0.createdAt >= oldestRetainedDate }
        refreshPendingCompletionIDs()
        persistPendingCommands()
    }

    private func refreshPendingCompletionIDs() {
        pendingCompletionIDs = Set(pendingCommands.compactMap { command in
            command.kind == .completeTask ? command.taskID : nil
        })
        persistWidgetSnapshot()
    }

    private func persistPendingCommands() {
        do {
            try FileManager.default.createDirectory(
                at: commandCacheURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try JSONEncoder().encode(pendingCommands).write(
                to: commandCacheURL,
                options: [.atomic, .completeFileProtection]
            )
        } catch {
            statusMessage = "A Watch change could not be saved for later delivery."
        }
    }

    private func persistSnapshot() {
        do {
            try FileManager.default.createDirectory(
                at: cacheURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try TaskifyWatchTransfer.encode(snapshot).write(
                to: cacheURL,
                options: [.atomic, .completeFileProtection]
            )
            persistWidgetSnapshot()
        } catch {
            statusMessage = "Tasks are available, but the local cache could not be updated."
        }
    }

    private func persistWidgetSnapshot() {
        let widgetSnapshot = TaskifyWatchWidgetSnapshot(
            snapshot: snapshot,
            excludingTaskIDs: pendingCompletionIDs
        )
        guard TaskifyWatchWidgetCache.saveIfChanged(widgetSnapshot) else { return }
        reloadComplicationTimelines()
    }

    private func reloadComplicationTimelines() {
        for kind in TaskifyWatchWidgetCache.widgetKinds {
            WidgetCenter.shared.reloadTimelines(ofKind: kind)
        }
    }

    private func sessionSetupTransfers() -> [WCSessionUserInfoTransfer] {
        guard WCSession.isSupported() else { return [] }
        return WCSession.default.outstandingUserInfoTransfers.filter {
            TaskifyWatchTransfer.isSetupNavigationRequest($0.userInfo)
        }
    }
}

extension TaskifyWatchAppModel: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        Task { @MainActor [weak self] in
            if error != nil {
                self?.statusMessage = "The iPhone connection is unavailable. Cached tasks remain available."
            } else {
                self?.requestInitialSetupNavigation()
                self?.retryPendingCommands()
                await self?.requestLatestSnapshotFromPhone()
            }
        }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        guard session.isReachable else { return }
        Task { @MainActor [weak self] in
            self?.requestInitialSetupNavigation()
            self?.retryPendingCommands()
            await self?.requestLatestSnapshotFromPhone()
        }
    }

    nonisolated func session(
        _ session: WCSession,
        didReceiveMessageData messageData: Data,
        replyHandler: @escaping (Data) -> Void
    ) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                replyHandler(try self.acceptProvisioning(messageData))
            } catch {
                self.statusMessage = error.localizedDescription
                replyHandler(Data())
            }
        }
    }

    nonisolated func session(
        _ session: WCSession,
        didReceiveApplicationContext applicationContext: [String: Any]
    ) {
        Task { @MainActor [weak self] in
            self?.apply(applicationContext: applicationContext)
        }
    }
}
