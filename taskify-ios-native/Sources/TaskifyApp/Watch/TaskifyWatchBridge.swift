import Combine
import Foundation
import TaskifyWatchShared
import WatchConnectivity

/// Owns the iPhone side of the companion link. Private key material is sent only with
/// `sendMessageData`, which requires the Watch app to be running and reachable; it is never put
/// in application context or a background transfer queue.
final class TaskifyWatchBridge: NSObject, ObservableObject {
    static let shared = TaskifyWatchBridge()
    private static let acknowledgedCommandIDsKey = "taskify.watch.acknowledged-command-ids.v1"
    private static let acknowledgedCommandLimit = 100

    enum State: Equatable {
        case unavailable(String)
        case activating
        case ready
        case provisioning
        case provisioned
        case failed(String)

        var message: String {
            switch self {
            case .unavailable(let reason): reason
            case .activating: "Checking Apple Watch…"
            case .ready: "Open Taskify on your Watch to finish secure setup."
            case .provisioning: "Sending account securely…"
            case .provisioned: "The Nostr account is stored securely on the Watch."
            case .failed(let reason): reason
            }
        }
    }

    @Published private(set) var state: State = .activating
    private weak var model: AppModel?

    private override init() {
        super.init()
    }

    @MainActor
    func activate(model: AppModel) {
        self.model = model
        guard WCSession.isSupported() else {
            state = .unavailable("Apple Watch connectivity is unavailable on this device.")
            return
        }
        let session = WCSession.default
        session.delegate = self
        state = .activating
        session.activate()
    }

    @MainActor
    func provision(using model: AppModel) {
        guard WCSession.isSupported() else {
            state = .unavailable("Apple Watch connectivity is unavailable on this device.")
            return
        }
        let session = WCSession.default
        guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else {
            state = .unavailable("Install Taskify on the paired Apple Watch first.")
            return
        }
        guard session.isReachable else {
            state = .failed("Open Taskify on the unlocked Watch, then try again.")
            return
        }

        do {
            let payload = try model.watchProvisioningPayload()
            let data = try TaskifyWatchTransfer.encode(payload)
            state = .provisioning
            session.sendMessageData(data) { [weak self] replyData in
                do {
                    let receipt = try TaskifyWatchTransfer.decodeProvisioningReceipt(replyData)
                    guard receipt.publicKeyHex == payload.publicKeyHex else {
                        throw TaskifyWatchBridgeError.receiptMismatch
                    }
                    DispatchQueue.main.async {
                        self?.state = .provisioned
                        self?.sendSnapshot(payload.snapshot)
                    }
                } catch {
                    DispatchQueue.main.async {
                        self?.state = .failed("The Watch could not confirm secure setup.")
                    }
                }
            } errorHandler: { [weak self] _ in
                DispatchQueue.main.async {
                    self?.state = .failed("Secure setup failed. Keep Taskify open on the Watch and try again.")
                }
            }
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    func sendSnapshot(_ snapshot: TaskifyWatchSnapshot) {
        guard WCSession.isSupported(), WCSession.default.activationState == .activated else { return }
        do {
            let data = try TaskifyWatchTransfer.encode(snapshotIncludingAcknowledgements(snapshot))
            // Application context contains task display data only. It never contains an nsec,
            // raw private key, wallet seed, or Cashu proof.
            try WCSession.default.updateApplicationContext([
                TaskifyWatchTransfer.snapshotDataKey: data,
            ])
        } catch {
            // A later model revision will retry. Avoid logging payloads or key-adjacent state.
        }
    }

    @MainActor
    private func accept(_ command: TaskifyWatchCommand) throws -> TaskifyWatchCommandReceipt {
        guard let model else { throw TaskifyWatchBridgeError.modelUnavailable }

        switch command.kind {
        case .completeTask:
            // Completion commands are deliberately idempotent. Replayed background deliveries
            // acknowledge an already-completed/deleted task without toggling it back open.
            model.completeTasks([command.taskID])
        }

        recordAcknowledgement(command.id)
        let snapshot = snapshotIncludingAcknowledgements(model.watchSnapshot())
        sendSnapshot(snapshot)
        return TaskifyWatchCommandReceipt(commandID: command.id, snapshot: snapshot)
    }

    private func recordAcknowledgement(_ commandID: String) {
        var commandIDs = UserDefaults.standard.stringArray(
            forKey: Self.acknowledgedCommandIDsKey
        ) ?? []
        commandIDs.removeAll { $0 == commandID }
        commandIDs.append(commandID)
        if commandIDs.count > Self.acknowledgedCommandLimit {
            commandIDs.removeFirst(commandIDs.count - Self.acknowledgedCommandLimit)
        }
        UserDefaults.standard.set(commandIDs, forKey: Self.acknowledgedCommandIDsKey)
    }

    private func snapshotIncludingAcknowledgements(
        _ snapshot: TaskifyWatchSnapshot
    ) -> TaskifyWatchSnapshot {
        TaskifyWatchSnapshot(
            schemaVersion: snapshot.schemaVersion,
            tasks: snapshot.tasks,
            boards: snapshot.boards,
            selectedBoardID: snapshot.selectedBoardID,
            generatedAt: snapshot.generatedAt,
            acknowledgedCommandIDs: UserDefaults.standard.stringArray(
                forKey: Self.acknowledgedCommandIDsKey
            )
        )
    }

    private func refreshState(for session: WCSession, error: Error? = nil) {
        DispatchQueue.main.async { [weak self] in
            if error != nil {
                self?.state = .failed("Apple Watch connectivity could not be activated.")
            } else if !session.isPaired {
                self?.state = .unavailable("No Apple Watch is paired with this iPhone.")
            } else if !session.isWatchAppInstalled {
                self?.state = .unavailable("Install Taskify on the paired Apple Watch first.")
            } else {
                self?.state = .ready
            }
        }
    }
}

extension TaskifyWatchBridge: WCSessionDelegate {
    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        refreshState(for: session, error: error)
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}

    func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    func sessionWatchStateDidChange(_ session: WCSession) {
        refreshState(for: session)
    }

    func session(
        _ session: WCSession,
        didReceiveMessageData messageData: Data,
        replyHandler: @escaping (Data) -> Void
    ) {
        do {
            let command = try TaskifyWatchTransfer.decodeCommand(messageData)
            Task { @MainActor [weak self] in
                guard let self else {
                    replyHandler(Data())
                    return
                }
                do {
                    replyHandler(try TaskifyWatchTransfer.encode(self.accept(command)))
                } catch {
                    replyHandler(Data())
                }
            }
        } catch {
            replyHandler(Data())
        }
    }

    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        guard let data = userInfo[TaskifyWatchTransfer.commandDataKey] as? Data,
              let command = try? TaskifyWatchTransfer.decodeCommand(data) else { return }
        Task { @MainActor [weak self] in
            _ = try? self?.accept(command)
        }
    }
}

private enum TaskifyWatchBridgeError: Error {
    case receiptMismatch
    case modelUnavailable
}
