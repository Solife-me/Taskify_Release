import Foundation
import Observation
import Security
import TaskifyWatchShared
import WatchConnectivity

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
            "Open Taskify on your iPhone to interpret this dictation."
        case .invalidResponse:
            "Taskify couldn't interpret that. Try saying it another way."
        }
    }
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
    @ObservationIgnored private var pendingCommands: [TaskifyWatchCommand] = []
    @ObservationIgnored private var immediateCommandIDs: Set<String> = []
    @ObservationIgnored private var requestedInitialSetupNavigation = false

    override init() {
        let supportURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        cacheURL = supportURL.appendingPathComponent("taskify-watch-snapshot-v1.json")
        commandCacheURL = supportURL.appendingPathComponent("taskify-watch-commands-v1.json")
        super.init()
        isProvisioned = identityStore.containsIdentity()
        loadCachedSnapshot()
        loadPendingCommands()
        activateConnectivity()
        if isProvisioned {
            statusMessage = "Secure account ready"
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
        deliver(command)
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
        return true
    }

    func previewVoiceTasks(
        transcript input: String,
        boardID: String
    ) async throws -> TaskifyWatchVoicePreview {
        let transcript = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !transcript.isEmpty,
              WCSession.isSupported(),
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
        return true
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

    private func retryPendingCommands() {
        pendingCommands.forEach(deliver)
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
        // The only durable write of private material is this Keychain call. The decoded envelope
        // goes out of scope immediately after the receipt is produced.
        try identityStore.save(payload.privateKey)
        isProvisioned = true
        sessionSetupTransfers().forEach { $0.cancel() }
        apply(snapshot: payload.snapshot)
        statusMessage = "Secure account stored"
        return try TaskifyWatchTransfer.encode(
            TaskifyWatchProvisioningReceipt(publicKeyHex: payload.publicKeyHex)
        )
    }

    private func apply(applicationContext: [String: Any]) {
        guard let data = applicationContext[TaskifyWatchTransfer.snapshotDataKey] as? Data,
              let received = try? TaskifyWatchTransfer.decodeSnapshot(data) else { return }
        apply(snapshot: received)
    }

    private func apply(snapshot received: TaskifyWatchSnapshot) {
        guard received.generatedAt >= snapshot.generatedAt else { return }
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

    private func loadCachedSnapshot() {
        guard let data = try? Data(contentsOf: cacheURL),
              let cached = try? TaskifyWatchTransfer.decodeSnapshot(data) else { return }
        snapshot = cached
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
        } catch {
            statusMessage = "Tasks are available, but the local cache could not be updated."
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
            }
        }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        guard session.isReachable else { return }
        Task { @MainActor [weak self] in
            self?.requestInitialSetupNavigation()
            self?.retryPendingCommands()
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
