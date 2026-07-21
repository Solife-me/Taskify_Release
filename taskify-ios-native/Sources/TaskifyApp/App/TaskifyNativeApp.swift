import SwiftUI

@main
struct TaskifyNativeApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootTabView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active {
                        model.refreshNotificationStatus()
                        model.refreshSyncIfNeeded()
                    }
                }
        }
    }
}
