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

    @ObservationIgnored private let identityStore = TaskifyWatchIdentityStore()
    @ObservationIgnored private let cacheURL: URL

    override init() {
        let supportURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        cacheURL = supportURL.appendingPathComponent("taskify-watch-snapshot-v1.json")
        super.init()
        isProvisioned = identityStore.containsIdentity()
        loadCachedSnapshot()
        activateConnectivity()
        if isProvisioned {
            statusMessage = "Secure account ready"
        }
    }

    var todayTasks: [TaskifyWatchTask] {
        snapshot.todayTasks()
    }

    var upcomingTasks: [TaskifyWatchTask] {
        snapshot.upcomingTasks()
    }

    func tasks(for boardID: String) -> [TaskifyWatchTask] {
        snapshot.tasks(for: boardID)
    }

    private func activateConnectivity() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
        apply(applicationContext: session.receivedApplicationContext)
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
        persistSnapshot()
    }

    private func loadCachedSnapshot() {
        guard let data = try? Data(contentsOf: cacheURL),
              let cached = try? TaskifyWatchTransfer.decodeSnapshot(data) else { return }
        snapshot = cached
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
        guard error != nil else { return }
        Task { @MainActor [weak self] in
            self?.statusMessage = "The iPhone connection is unavailable. Cached tasks remain available."
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
