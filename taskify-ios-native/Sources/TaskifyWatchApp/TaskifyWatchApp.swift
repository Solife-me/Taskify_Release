import SwiftUI

@main
struct TaskifyWatchApp: App {
    @State private var model = TaskifyWatchAppModel()

    var body: some Scene {
        WindowGroup {
            TaskifyWatchRootView()
                .environment(model)
                .preferredColorScheme(.dark)
        }
    }
}
