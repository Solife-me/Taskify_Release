import SwiftUI
import TaskifyCore

@main
@MainActor
struct TaskifyNativeApp: App {
    @UIApplicationDelegateAdaptor(TaskifyApplicationDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: AppModel
    @StateObject private var wallet: WalletViewModel
    @AppStorage(TaskifyAppearanceSettings.scaleKey) private var interfaceScaleRaw = TaskifyInterfaceScale.system.rawValue
    @AppStorage(TaskifyAppearanceSettings.revisionKey) private var appearanceRevision = ""

    private var appAccent: Color {
        _ = appearanceRevision
        return TaskifyTheme.accent
    }

    init() {
        AttachmentFiles.purgeExpiredTemporaryFiles()
        ShareTransferStore.purgeOrphanedFiles()
        let model = AppModel()
        let wallet = WalletViewModel()
        model.registerWalletPaymentReceiver(wallet)
        TaskNotificationActionRouter.shared.register(model: model)
        TaskifyDMPushCoordinator.shared.register(model: model)
        _model = State(initialValue: model)
        _wallet = StateObject(wrappedValue: wallet)
        TaskifyBackgroundSyncCoordinator.shared.register(model: model, wallet: wallet)
        TaskifyWatchBridge.shared.activate(model: model)

        // Apple's documented API for keeping Shortcuts phrase/parameter data in sync after launch.
        TaskifyShortcuts.updateAppShortcutParameters()
    }

    var body: some Scene {
        WindowGroup {
            RootTabView()
                .environment(model)
                .environmentObject(wallet)
                .tint(appAccent)
                .preferredColorScheme(.dark)
                .taskifyInterfaceScale(TaskifyInterfaceScale(rawValue: interfaceScaleRaw) ?? .system)
                .task(id: model.isLoading) {
                    guard !model.isLoading else { return }
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
                    switch phase {
                    case .active:
                        TaskifyBackgroundSyncCoordinator.shared.appDidBecomeActive()
                        model.reloadIfChangedExternally()
                        Task {
                            await model.refreshShareState(retry: true)
                            await model.importSharedTaskDrafts()
                        }
                        model.refreshNotificationStatus()
                        model.refreshSyncIfNeeded()
                        model.refreshFullWeekRecurrencesIfNeeded()
                        model.refreshContactsIfNeeded()
                        model.refreshAccountSyncIfNeeded()
                        model.refreshAppStateSyncIfNeeded()
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
        .commands { TaskifyKeyboardCommands() }
    }
}
