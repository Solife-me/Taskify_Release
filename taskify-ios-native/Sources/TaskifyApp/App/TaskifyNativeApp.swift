import SwiftUI

@main
struct TaskifyNativeApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootTabView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
        }
    }
}
