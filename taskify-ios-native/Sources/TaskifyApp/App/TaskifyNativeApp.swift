import AppIntents
import SwiftUI
import TaskifyCore

/// Must live in the TaskifyApp target, not TaskifyCore: Xcode's App Intents metadata extraction
/// picks up `TaskifyAddTaskIntent` fine from the TaskifyCore package (verified via
/// `Metadata.appintents/extract.actionsdata` in the built app -- it shows up there with
/// `isDiscoverable: true`), but an `AppShortcutsProvider` defined in that same package is silently
/// dropped from the extracted metadata entirely. That's why Siri/Spotlight/Shortcuts never showed
/// Taskify despite the intent itself building and running correctly.
public struct TaskifyShortcuts: AppShortcutsProvider {
    public static var appShortcuts: [AppShortcut] {
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
        }
    }
}
