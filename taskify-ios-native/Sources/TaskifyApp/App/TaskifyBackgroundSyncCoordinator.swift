import BackgroundTasks
import Foundation
import UIKit

@MainActor
final class TaskifyBackgroundSyncCoordinator {
    static let shared = TaskifyBackgroundSyncCoordinator()
    static let refreshIdentifier = "solife.me.Taskify.Native.refresh"

    private weak var model: AppModel?
    private weak var wallet: WalletViewModel?
    private var isRegistered = false
    private var refreshOperation: Task<Void, Never>?
    private var handoffOperation: Task<Void, Never>?
    private var backgroundTaskIdentifier: UIBackgroundTaskIdentifier = .invalid
    private var currentRefreshCompleted = false

    private init() {}

    func register(model: AppModel, wallet: WalletViewModel) {
        self.model = model
        self.wallet = wallet
        guard !isRegistered else { return }
        isRegistered = BGTaskScheduler.shared.register(
            forTaskWithIdentifier: Self.refreshIdentifier,
            using: nil
        ) { [weak self] task in
            Task { @MainActor in
                guard let self, let refreshTask = task as? BGAppRefreshTask else {
                    task.setTaskCompleted(success: false)
                    return
                }
                self.handle(refreshTask)
            }
        }
        scheduleNextRefresh()
    }

    func appDidBecomeActive() {
        scheduleNextRefresh()
    }

    func appDidEnterBackground() {
        scheduleNextRefresh()
        guard let model else { return }

        handoffOperation?.cancel()
        endBackgroundTask()
        backgroundTaskIdentifier = UIApplication.shared.beginBackgroundTask(
            withName: "Taskify sync handoff"
        ) { [weak self] in
            Task { @MainActor in
                self?.handoffOperation?.cancel()
                self?.endBackgroundTask()
            }
        }
        handoffOperation = Task { @MainActor [weak self, weak model] in
            guard let self, let model else { return }
            async let syncHandoff: Void = model.prepareForBackground()
            async let walletRefresh = self.wallet?.performBackgroundLightningRefresh() ?? true
            _ = await (syncHandoff, walletRefresh)
            _ = await self.wallet?.performBackgroundPaymentRequestRefresh()
            guard !Task.isCancelled else { return }
            endBackgroundTask()
            handoffOperation = nil
        }
    }

    private func scheduleNextRefresh() {
        guard isRegistered else { return }
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.refreshIdentifier)
        let request = BGAppRefreshTaskRequest(identifier: Self.refreshIdentifier)
        let delay: TimeInterval = wallet?.hasOutstandingLightningInvoices == true
            ? 60
            : 15 * 60
        request.earliestBeginDate = Date().addingTimeInterval(delay)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            #if DEBUG
            print("Taskify background refresh could not be scheduled: \(error.localizedDescription)")
            #endif
        }
    }

    private func handle(_ task: BGAppRefreshTask) {
        scheduleNextRefresh()
        refreshOperation?.cancel()
        currentRefreshCompleted = false

        task.expirationHandler = { [weak self, weak task] in
            Task { @MainActor in
                guard let self, let task else { return }
                self.refreshOperation?.cancel()
                self.model?.backgroundRefreshExpired()
                self.complete(task, success: false)
            }
        }

        refreshOperation = Task { @MainActor [weak self, weak task] in
            guard let self, let task, let model else { return }
            async let syncSucceeded = model.performBackgroundRefresh()
            async let walletSucceeded = self.wallet?.performBackgroundLightningRefresh() ?? true
            let results = await (syncSucceeded, walletSucceeded)
            let paymentRequestSucceeded = await self.wallet?
                .performBackgroundPaymentRequestRefresh() ?? true
            let success = results.0 && results.1 && paymentRequestSucceeded
            guard !Task.isCancelled else { return }
            complete(task, success: success)
        }
    }

    private func complete(_ task: BGAppRefreshTask, success: Bool) {
        guard !currentRefreshCompleted else { return }
        currentRefreshCompleted = true
        task.expirationHandler = nil
        task.setTaskCompleted(success: success)
        refreshOperation = nil
    }

    private func endBackgroundTask() {
        guard backgroundTaskIdentifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTaskIdentifier)
        backgroundTaskIdentifier = .invalid
    }
}
