import Combine
import Foundation
import TaskifyCore
import TaskifyWatchShared
import WatchConnectivity

/// Owns the iPhone side of the companion link. Private key material is sent only with
/// `sendMessageData`, which requires the Watch app to be running and reachable; it is never put
/// in application context or a background transfer queue.
final class TaskifyWatchBridge: NSObject, ObservableObject {
    static let shared = TaskifyWatchBridge()
    private static let acknowledgedCommandIDsKey = "taskify.watch.acknowledged-command-ids.v1"
    private static let pendingSetupNavigationRequestKey = "taskify.watch.pending-setup-navigation-request.v1"
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
    @Published private(set) var pendingSetupNavigationRequestID: UUID?
    private weak var model: AppModel?
    private var processingCommandIDs: Set<String> = []
    private var hasProvisionedCurrentWatch = false
    private var snapshotDeliveryTask: Task<Void, Never>?

    private override init() {
        pendingSetupNavigationRequestID = UserDefaults.standard
            .string(forKey: Self.pendingSetupNavigationRequestKey)
            .flatMap(UUID.init(uuidString:))
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
                        self?.hasProvisionedCurrentWatch = true
                        self?.clearPendingSetupNavigationRequest()
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

    /// Coalesces rapid model revisions and builds the constrained Watch projection away from
    /// MainActor. Initial relay replay can update the local snapshot several times; generating
    /// and JSON-encoding up to 500 Watch tasks for every revision used to steal frames from the
    /// Boards scroller even when WatchConnectivity only needed the final application context.
    @MainActor
    func scheduleSnapshot(from model: AppModel) {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated,
              session.isPaired,
              session.isWatchAppInstalled else { return }

        let source = model.snapshot
        let calendar = model.watchDataCalendar
        snapshotDeliveryTask?.cancel()
        snapshotDeliveryTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            let watchSnapshot = await Task.detached(priority: .utility) {
                source.watchData(calendar: calendar)
            }.value
            guard !Task.isCancelled else { return }
            self?.sendSnapshot(watchSnapshot)
        }
    }

    @MainActor
    func consumeSetupNavigationRequest(_ requestID: UUID) {
        guard pendingSetupNavigationRequestID == requestID else { return }
        clearPendingSetupNavigationRequest()
    }

    @MainActor
    private func clearPendingSetupNavigationRequest() {
        pendingSetupNavigationRequestID = nil
        UserDefaults.standard.removeObject(forKey: Self.pendingSetupNavigationRequestKey)
    }

    private func recordSetupNavigationRequest() {
        DispatchQueue.main.async { [weak self] in
            guard let self,
                  !self.hasProvisionedCurrentWatch,
                  self.pendingSetupNavigationRequestID == nil else { return }
            let requestID = UUID()
            self.pendingSetupNavigationRequestID = requestID
            UserDefaults.standard.set(
                requestID.uuidString,
                forKey: Self.pendingSetupNavigationRequestKey
            )
        }
    }

    @MainActor
    private func accept(_ command: TaskifyWatchCommand) async throws -> TaskifyWatchCommandReceipt {
        guard let model else { throw TaskifyWatchBridgeError.modelUnavailable }

        if acknowledgedCommandIDs().contains(command.id) {
            return TaskifyWatchCommandReceipt(
                commandID: command.id,
                snapshot: snapshotIncludingAcknowledgements(model.watchSnapshot())
            )
        }
        guard processingCommandIDs.insert(command.id).inserted else {
            throw TaskifyWatchBridgeError.commandAlreadyProcessing
        }
        defer { processingCommandIDs.remove(command.id) }

        switch command.kind {
        case .completeTask:
            // Completion commands are deliberately idempotent. Replayed background deliveries
            // acknowledge an already-completed/deleted task without toggling it back open.
            guard let taskID = command.taskID else { throw TaskifyWatchBridgeError.invalidCommand }
            model.completeTasks([taskID])

        case .createTask:
            guard let title = command.title,
                  let boardID = command.boardID,
                  model.addTaskFromWatch(title: title, boardID: boardID, commandID: command.id) else {
                throw TaskifyWatchBridgeError.invalidCommand
            }

        case .createVoiceTasks:
            guard let boardID = command.boardID,
                  let drafts = command.voiceTasks,
                  !drafts.isEmpty else {
                throw TaskifyWatchBridgeError.invalidCommand
            }
            let tasks = drafts.map {
                VoiceFinalTask(
                    title: $0.title,
                    dueISO: $0.dueISO,
                    notes: $0.notes,
                    subtasks: $0.subtasks,
                    priority: $0.priority
                )
            }
            guard model.addTasksFromVoice(
                tasks,
                defaultBoardID: boardID,
                taskIDPrefix: "watch-\(command.id)"
            ) == tasks.count else {
                throw TaskifyWatchBridgeError.invalidCommand
            }

        case .processVoiceTranscript:
            guard let transcript = command.transcript?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !transcript.isEmpty,
                  let boardID = command.boardID,
                  !model.identityNpub.isEmpty else {
                throw TaskifyWatchBridgeError.invalidCommand
            }

            let finalTasks = try await finalizedVoiceTasks(
                transcript: transcript,
                boardID: boardID,
                using: model
            )
            guard model.addTasksFromVoice(
                finalTasks,
                defaultBoardID: boardID,
                taskIDPrefix: "watch-\(command.id)"
            ) > 0 else {
                throw TaskifyWatchBridgeError.invalidCommand
            }
        }

        recordAcknowledgement(command.id)
        let snapshot = snapshotIncludingAcknowledgements(model.watchSnapshot())
        sendSnapshot(snapshot)
        return TaskifyWatchCommandReceipt(commandID: command.id, snapshot: snapshot)
    }

    @MainActor
    private func voicePreview(
        for request: TaskifyWatchVoicePreviewRequest
    ) async throws -> TaskifyWatchVoicePreview {
        guard let model else { throw TaskifyWatchBridgeError.modelUnavailable }
        let transcript = request.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        let finalTasks = try await finalizedVoiceTasks(
            transcript: transcript,
            boardID: request.boardID,
            using: model
        )
        guard !finalTasks.isEmpty else { throw TaskifyWatchBridgeError.invalidCommand }
        return TaskifyWatchVoicePreview(
            requestID: request.id,
            transcript: transcript,
            tasks: finalTasks.enumerated().map { index, task in
                TaskifyWatchVoiceDraft(
                    id: "\(request.id)-\(index)",
                    title: task.title,
                    dueISO: task.dueISO,
                    notes: task.notes,
                    subtasks: task.subtasks,
                    priority: task.priority
                )
            }
        )
    }

    @MainActor
    private func finalizedVoiceTasks(
        transcript: String,
        boardID: String,
        using model: AppModel
    ) async throws -> [VoiceFinalTask] {
        guard !transcript.isEmpty, !model.identityNpub.isEmpty else {
            throw TaskifyWatchBridgeError.invalidCommand
        }
        let client = VoiceDictationClient()
        let extraction = try await client.extract(
            npub: model.identityNpub,
            transcript: transcript,
            candidates: [],
            sessionDurationSeconds: max(
                1,
                transcript.split(whereSeparator: { $0.isWhitespace }).count / 2
            )
        )
        var voiceSession = VoiceSessionState()
        voiceSession.commitTranscript(transcript)
        voiceSession.apply(extraction.operations)
        let candidates = voiceSession.confirmedCandidates.isEmpty
            ? [VoiceTaskCandidate(title: transcript)]
            : voiceSession.confirmedCandidates
        return await client.finalize(
            npub: model.identityNpub,
            candidates: candidates,
            boardID: boardID
        )
    }

    private func recordAcknowledgement(_ commandID: String) {
        var commandIDs = acknowledgedCommandIDs()
        commandIDs.removeAll { $0 == commandID }
        commandIDs.append(commandID)
        if commandIDs.count > Self.acknowledgedCommandLimit {
            commandIDs.removeFirst(commandIDs.count - Self.acknowledgedCommandLimit)
        }
        UserDefaults.standard.set(commandIDs, forKey: Self.acknowledgedCommandIDsKey)
    }

    private func acknowledgedCommandIDs() -> [String] {
        UserDefaults.standard.stringArray(forKey: Self.acknowledgedCommandIDsKey) ?? []
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
            acknowledgedCommandIDs: acknowledgedCommandIDs()
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
            } else if self?.hasProvisionedCurrentWatch == true {
                self?.state = .provisioned
            } else {
                self?.state = .ready
            }
            if error == nil, let self, let model = self.model {
                self.scheduleSnapshot(from: model)
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
        if let request = try? TaskifyWatchTransfer.decodeVoicePreviewRequest(messageData) {
            Task { @MainActor [weak self] in
                guard let self else {
                    replyHandler(Data())
                    return
                }
                do {
                    replyHandler(try TaskifyWatchTransfer.encode(await self.voicePreview(for: request)))
                } catch {
                    replyHandler(Data())
                }
            }
            return
        }
        do {
            let command = try TaskifyWatchTransfer.decodeCommand(messageData)
            Task { @MainActor [weak self] in
                guard let self else {
                    replyHandler(Data())
                    return
                }
                do {
                    replyHandler(try TaskifyWatchTransfer.encode(await self.accept(command)))
                } catch {
                    replyHandler(Data())
                }
            }
        } catch {
            replyHandler(Data())
        }
    }

    func session(
        _ session: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void
    ) {
        guard TaskifyWatchTransfer.isSetupNavigationRequest(message) else {
            replyHandler([:])
            return
        }
        recordSetupNavigationRequest()
        replyHandler([TaskifyWatchTransfer.commandAcceptedKey: true])
    }

    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        if TaskifyWatchTransfer.isSetupNavigationRequest(userInfo) {
            recordSetupNavigationRequest()
            return
        }
        guard let data = userInfo[TaskifyWatchTransfer.commandDataKey] as? Data,
              let command = try? TaskifyWatchTransfer.decodeCommand(data) else { return }
        Task { @MainActor [weak self] in
            _ = try? await self?.accept(command)
        }
    }
}

private enum TaskifyWatchBridgeError: Error {
    case receiptMismatch
    case modelUnavailable
    case commandAlreadyProcessing
    case invalidCommand
}
