import SwiftUI

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
