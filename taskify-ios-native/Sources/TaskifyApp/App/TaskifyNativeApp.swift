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
                "Add a \(.applicationName) task",
                "Create a \(.applicationName) task",
                "Add something to \(.applicationName)",
                "Put a task in \(.applicationName)",
                "New task in \(.applicationName)",
                "Add a task to \(.applicationName)",
                "Add a task in \(.applicationName)",
                "Create a task in \(.applicationName)",
                "Make a new task in \(.applicationName)",
                "Use \(.applicationName) to add a task",
            ],
            shortTitle: "Add Task",
            systemImageName: "checklist"
        )
        AppShortcut(
            intent: TaskifyNaturalAddTaskIntent(),
            phrases: [
                "Add \(\.$task) in \(.applicationName)",
                "Create \(\.$task) in \(.applicationName)",
                "Add \(\.$task) to \(.applicationName)",
                "\(.applicationName) add \(\.$task)",
                "In \(.applicationName) add \(\.$task)",
            ],
            shortTitle: "Quick Add Task",
            systemImageName: "plus.circle"
        )
    }
}

@main
@MainActor
struct TaskifyNativeApp: App {
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
        let model = AppModel()
        let wallet = WalletViewModel()
        model.registerWalletPaymentReceiver(wallet)
        TaskNotificationActionRouter.shared.register(model: model)
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
                .dynamicTypeSize(
                    TaskifyInterfaceScale(rawValue: interfaceScaleRaw)?.dynamicTypeSize
                        ?? TaskifyInterfaceScale.system.dynamicTypeSize
                )
                .task(id: model.isLoading) {
                    guard !model.isLoading else { return }
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
                        model.refreshNotificationStatus()
                        model.refreshSyncIfNeeded()
                        model.refreshFullWeekRecurrencesIfNeeded()
                        model.refreshContactsIfNeeded()
                        model.refreshAccountSyncIfNeeded()
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
                    TaskifyWatchBridge.shared.scheduleSnapshot(from: model)
                }
        }
    }
}
