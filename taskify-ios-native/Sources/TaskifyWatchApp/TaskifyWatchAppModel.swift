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
    private(set) var statusMessage = "Open Taskify Settings on your iPhone to enable Watch sync."
    private(set) var pendingCompletionIDs: Set<String> = []

    @ObservationIgnored private let identityStore = TaskifyWatchIdentityStore()
    @ObservationIgnored private let cacheURL: URL
    @ObservationIgnored private let commandCacheURL: URL
    @ObservationIgnored private var pendingCommands: [TaskifyWatchCommand] = []
    @ObservationIgnored private var immediateCommandIDs: Set<String> = []

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

    func completeTask(_ taskID: String) {
        guard snapshot.tasks.contains(where: { $0.id == taskID }),
              !pendingCompletionIDs.contains(taskID) else { return }
        let command = TaskifyWatchCommand(kind: .completeTask, taskID: taskID)
        pendingCommands.append(command)
        pendingCompletionIDs.insert(taskID)
        persistPendingCommands()
        deliver(command)
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
        statusMessage = "Completion saved — it will sync when the iPhone is available."
    }

    private func finish(commandID: String) {
        pendingCommands.removeAll { $0.id == commandID }
        pendingCompletionIDs = Set(pendingCommands.map(\.taskID))
        persistPendingCommands()
        statusMessage = pendingCommands.isEmpty ? "Tasks are up to date" : "Waiting to sync completions"
    }

    private func acceptProvisioning(_ data: Data) throws -> Data {
        let payload = try TaskifyWatchTransfer.decodeProvisioningPayload(data)
        // The only durable write of private material is this Keychain call. The decoded envelope
        // goes out of scope immediately after the receipt is produced.
        try identityStore.save(payload.privateKey)
        isProvisioned = true
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
            pendingCommands.removeAll { acknowledged.contains($0.id) }
            pendingCompletionIDs = Set(pendingCommands.map(\.taskID))
            persistPendingCommands()
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
        pendingCompletionIDs = Set(pendingCommands.map(\.taskID))
        persistPendingCommands()
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
            statusMessage = "A completion could not be saved for later delivery."
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
                self?.retryPendingCommands()
            }
        }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        guard session.isReachable else { return }
        Task { @MainActor [weak self] in
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
