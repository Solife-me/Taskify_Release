import AppIntents
import SwiftUI
import TaskifyCore

/// Like `TaskifyAddTaskIntent`, this must live in the app target rather than the TaskifyCore
/// package: an `AppShortcutsProvider` defined in the package is dropped from the extracted
/// `Metadata.appintents` entirely, so the system never learns Taskify has any Siri phrases.
struct TaskifyShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: TaskifyAddTaskIntent(),
            phrases: [
                "Add a task to \(.applicationName)",
                "Add a new task in \(.applicationName)",
                "Create a task in \(.applicationName)",
            ],
            shortTitle: "Add Task",
            systemImageName: "checklist"
        )
    }
}

@main
@MainActor
struct TaskifyNativeApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: AppModel
    @StateObject private var wallet: WalletViewModel

    init() {
        let model = AppModel()
        let wallet = WalletViewModel()
        model.registerWalletPaymentReceiver(wallet)
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
                .preferredColorScheme(.dark)
                .task {
                    await wallet.start(
                        recoverLightningReceives: scenePhase == .active
                    )
                }
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .active:
                        TaskifyBackgroundSyncCoordinator.shared.appDidBecomeActive()
                        model.reloadIfChangedExternally()
                        model.refreshNotificationStatus()
                        model.refreshSyncIfNeeded()
                        model.refreshContactsIfNeeded()
                        wallet.appDidBecomeActive()
                    case .background:
                        TaskifyBackgroundSyncCoordinator.shared.appDidEnterBackground()
                        wallet.appDidEnterBackground()
                    case .inactive:
                        break
                    @unknown default:
                        break
                    }
                }
                .onChange(of: model.snapshotRevision) { _, _ in
                    TaskifyWatchBridge.shared.sendSnapshot(model.watchSnapshot())
                }
        }
    }
}
