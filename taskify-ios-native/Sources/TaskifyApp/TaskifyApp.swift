import SwiftData
import SwiftUI
import TaskifyCore

@main
struct TaskifyApp: App {
    @StateObject private var authVM = AppAuthViewModel()
    @StateObject private var dataController = DataController()
    @StateObject private var settingsManager = SettingsManager()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(authVM)
                .environmentObject(dataController)
                .environmentObject(settingsManager)
                .modelContainer(for: [TaskifyTask.self, TaskifyBoard.self, TaskifyCalendarEvent.self, TaskifyContact.self, TaskifyPublicFollow.self])
                .task { await authVM.bootstrap() }
                .preferredColorScheme(colorScheme)
                .taskifyBaseFontSize(settingsManager.settings.baseFontSize)
                .appAccent(settingsManager.settings.accent)
        }
    }

    private var colorScheme: ColorScheme? {
        switch settingsManager.settings.appearance {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}
