import SwiftUI
import TaskifyCore
import UIKit

@main
@MainActor
struct TaskifyNativeApp: App {
    @UIApplicationDelegateAdaptor(TaskifyApplicationDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    private let workspace: Workspace?
    @State private var localResetRequested = false
    @AppStorage(TaskifyAppearanceSettings.scaleKey) private var interfaceScaleRaw = TaskifyInterfaceScale.system.rawValue
    @AppStorage(TaskifyAppearanceSettings.revisionKey) private var appearanceRevision = ""

    private var appAccent: Color {
        _ = appearanceRevision
        return TaskifyTheme.accent
    }

    init() {
        TaskifyBackgroundSyncCoordinator.shared.installHandler()
        do {
            try TaskifyLocalReset.finishIfRequested()
            workspace = Workspace()
        } catch {
            workspace = nil
        }
    }

    private struct Workspace {
        let model: AppModel
        let wallet: WalletViewModel

        @MainActor
        init() {
            AttachmentFiles.purgeExpiredTemporaryFiles()
            ShareTransferStore.purgeOrphanedFiles()
            model = AppModel(syncEngine: Self.makeSyncEngine())
            wallet = WalletViewModel()
            model.registerWalletPaymentReceiver(wallet)
            TaskNotificationActionRouter.shared.register(model: model)
            TaskifyDMPushCoordinator.shared.register(model: model)
            TaskifyBackgroundSyncCoordinator.shared.register(model: model, wallet: wallet)
            TaskifyWatchBridge.shared.activate(model: model)

            // Keep Shortcuts phrase and parameter data in sync after launch.
            TaskifyShortcuts.updateAppShortcutParameters()
        }

        private static func makeSyncEngine() -> TaskSyncEngine {
#if DEBUG
            let environment = ProcessInfo.processInfo.environment
            if environment["TASKIFY_UI_TEST_ACCOUNT_SYNC"] == "1" {
                let outboxURL = NostrOutboxStore.defaultURL.deletingLastPathComponent()
                    .appendingPathComponent("account-sync-ui-test-outbox.json")
                if environment["TASKIFY_UI_TEST_FRESH_STORE"] == "1" {
                    try? FileManager.default.removeItem(at: outboxURL)
                }
                return TaskSyncEngine(outbox: NostrOutboxStore(fileURL: outboxURL), networkingEnabled: false)
            }
#endif
            return TaskSyncEngine()
        }
    }

    private func requestLocalReset(in workspace: Workspace) throws {
        try TaskifyLocalReset.request()
        localResetRequested = true
        TaskifyBackgroundSyncCoordinator.shared.suspendForLocalReset()
        TaskifyDMPushCoordinator.shared.unregister(model: workspace.model)
        TaskNotificationActionRouter.shared.unregister(model: workspace.model)
        TaskifyWatchBridge.shared.suspendForLocalReset()
        UIApplication.shared.unregisterForRemoteNotifications()
        workspace.wallet.appDidEnterBackground()
        workspace.wallet.resetNostrAccountScopedState()
        Task { await workspace.model.stopForAccountSwitch() }
    }

    var body: some Scene {
        WindowGroup {
            if localResetRequested {
                ContentUnavailableView(
                    "Close and reopen Taskify",
                    systemImage: "arrow.clockwise",
                    description: Text("Swipe Taskify away in the app switcher, then open it again to finish deleting the local data.")
                )
            } else if let workspace {
                workspaceView(workspace)
            } else {
                ContentUnavailableView(
                    "Local deletion couldn’t finish",
                    systemImage: "exclamationmark.triangle",
                    description: Text("Unlock your device, then close and reopen Taskify to retry.")
                )
            }
        }
        .commands { TaskifyKeyboardCommands() }
    }

    private func workspaceView(_ workspace: Workspace) -> some View {
        let model = workspace.model
        let wallet = workspace.wallet
        return RootTabView(requestLocalReset: { try requestLocalReset(in: workspace) })
            .environment(model)
            .environmentObject(wallet)
            .tint(appAccent)
            .preferredColorScheme(.dark)
            .taskifyInterfaceScale(TaskifyInterfaceScale(rawValue: interfaceScaleRaw) ?? .system)
            .task(id: model.isLoading || model.showsFirstRunOnboarding) {
                guard !model.isLoading, !model.showsFirstRunOnboarding else { return }
                await model.refreshShareState(retry: true)
                await model.importSharedTaskDrafts()
                // Cashu recovery is important but unrelated to drawing the Boards tab.
                // Let the populated board accept its first gestures before starting the
                // wallet's database/recovery work on launch.
                try? await Task.sleep(for: .milliseconds(900))
                guard !Task.isCancelled else { return }
                await wallet.start(
                    recoverLightningReceives: scenePhase == .active
                )
            }
            .onChange(of: scenePhase) { _, phase in
                guard !localResetRequested else { return }
                switch phase {
                case .active:
                    model.refreshICloudKeyRecoveryStatus()
                    TaskifyBackgroundSyncCoordinator.shared.appDidBecomeActive()
                    model.reloadIfChangedExternally()
                    Task {
                        await model.refreshShareState(retry: true)
                        await model.importSharedTaskDrafts()
                    }
                    model.refreshNotificationStatus()
                    model.refreshSyncIfNeeded()
                    model.refreshFullWeekRecurrencesIfNeeded()
                    model.refreshAccountSyncIfNeeded()
                    wallet.appDidBecomeActive()
                case .background:
                    model.flushAppStateSync()
                    TaskifyBackgroundSyncCoordinator.shared.appDidEnterBackground()
                    wallet.appDidEnterBackground()
                case .inactive:
                    break
                @unknown default:
                    break
                }
            }
            .onChange(of: model.snapshotRevision) { _, _ in
                TaskifyWatchBridge.shared.scheduleSnapshot(from: model)
            }
            .onChange(of: model.directMessageRevision) { _, _ in
                model.scheduleShareRefresh()
            }
            .onChange(of: appearanceRevision) { _, _ in
                TaskifyWatchBridge.shared.scheduleSnapshot(from: model)
            }
    }
}
