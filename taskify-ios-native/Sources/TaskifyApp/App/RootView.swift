import SwiftData
import SwiftUI
import TaskifyCore

struct RootView: View {
    @EnvironmentObject private var authVM: AppAuthViewModel
    @EnvironmentObject private var dataController: DataController
    @EnvironmentObject private var settingsManager: SettingsManager
    @Environment(\.modelContext) private var modelContext

    @State private var showFirstRunOnboarding: Bool?

    var body: some View {
        Group {
            if !authVM.hasBootstrapped || showFirstRunOnboarding == nil {
                ProgressView("Loading Taskify...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(ThemeColors.surfaceGrouped)
            } else {
                ZStack {
                    baseContent
                        .disabled(showFirstRunOnboarding == true)
                        .blur(radius: showFirstRunOnboarding == true ? 10 : 0)

                    if showFirstRunOnboarding == true {
                        onboardingOverlay
                            .transition(.opacity.combined(with: .scale(scale: 0.98)))
                    }
                }
                .animation(.easeInOut(duration: 0.22), value: showFirstRunOnboarding == true)
            }
        }
        .task(id: authVM.hasBootstrapped) {
            guard authVM.hasBootstrapped, showFirstRunOnboarding == nil else { return }
            showFirstRunOnboarding = FirstRunOnboardingGate.shouldShowFirstRunOnboarding(
                secretKeyHex: authVM.activeProfile?.nsecHex,
                onboardingDone: FirstRunOnboardingStore.isCompleted()
            )
        }
    }

    @ViewBuilder
    private var baseContent: some View {
        if showFirstRunOnboarding == true, authVM.activeProfile == nil {
            OnboardingBackdropView()
        } else {
            switch authVM.state {
            case .signedIn(let profile):
                NativeAppShellView(profile: profile)
                    .task {
                        await dataController.bootstrap(profile: profile, modelContext: modelContext)
                    }
            case .importing:
                ProgressView("Signing in...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(ThemeColors.surfaceGrouped)
            case .error(let message):
                SignInView(errorMessage: message)
            case .signedOut:
                SignInView(errorMessage: nil)
            }
        }
    }

    private var onboardingOverlay: some View {
        ZStack {
            Color.black.opacity(0.16)
                .ignoresSafeArea()

            FirstRunOnboardingView(
                pushSupported: NotificationPermissionCoordinator.isSupported,
                pushConfigured: NotificationPermissionCoordinator.isSupported,
                cloudRestoreAvailable: false,
                onUseExistingKey: { value in
                    authVM.useExistingOnboardingKey(value)
                },
                onGenerateNewKey: {
                    authVM.generateOnboardingLogin()
                },
                onRestoreFromBackupFile: { data in
                    try authVM.restoreFromBackup(data: data, settingsManager: settingsManager)
                    completeFirstRunOnboarding()
                },
                onRestoreFromCloud: { _ in
                    throw OnboardingUnavailableError.cloudRestoreUnavailable
                },
                onEnableNotifications: {
                    let permission = try await NotificationPermissionCoordinator.requestAuthorization(
                        settingsManager: settingsManager
                    )
                    if permission != .granted {
                        throw NotificationPermissionError.denied
                    }
                },
                onComplete: {
                    completeFirstRunOnboarding()
                }
            )
            .padding(20)
            .frame(maxWidth: 620)
        }
    }

    private func completeFirstRunOnboarding() {
        FirstRunOnboardingStore.markCompleted()
        showFirstRunOnboarding = false
    }
}

struct NativeAppShellView: View {
    @StateObject private var shellVM: AppShellViewModel
    @EnvironmentObject private var dataController: DataController
    @EnvironmentObject private var settingsManager: SettingsManager

    init(profile: TaskifyProfile) {
        _shellVM = StateObject(wrappedValue: AppShellViewModel(profile: profile))
    }

    var body: some View {
        let currentProfile = dataController.currentProfile ?? shellVM.profile
        TabView(selection: Binding(
            get: { shellVM.selectedTab },
            set: { shellVM.select(tab: $0) }
        )) {
            BoardsShellScreen(shellVM: shellVM)
                .tabItem { Label("Boards", systemImage: "square.grid.2x2") }
                .tag(AppShellViewModel.Tab.boards)

            UpcomingShellScreen(profile: currentProfile)
                .tabItem { Label("Upcoming", systemImage: "calendar") }
                .tag(AppShellViewModel.Tab.upcoming)

            ContactsShellScreen(profile: currentProfile)
                .tabItem { Label("Contacts", systemImage: "person.2") }
                .tag(AppShellViewModel.Tab.contacts)

            SettingsShellScreen(profile: currentProfile)
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(AppShellViewModel.Tab.settings)
        }
        .tint(ThemeColors.accent(for: settingsManager.settings.accent))
    }
}

private enum OnboardingUnavailableError: LocalizedError {
    case cloudRestoreUnavailable

    var errorDescription: String? {
        switch self {
        case .cloudRestoreUnavailable:
            return "Cloud backup service is unavailable in this app build."
        }
    }
}

private struct OnboardingBackdropView: View {
    @Environment(\.appAccent) private var accent

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    ThemeColors.surfaceGrouped,
                    ThemeColors.surfaceRaised,
                    ThemeColors.surfaceBase,
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            Circle()
                .fill(ThemeColors.accent(for: accent).opacity(0.12))
                .frame(width: 260, height: 260)
                .offset(x: 120, y: -180)
                .blur(radius: 10)

            Circle()
                .fill(ThemeColors.accent(for: accent).opacity(0.08))
                .frame(width: 200, height: 200)
                .offset(x: -140, y: 220)
                .blur(radius: 24)

            VStack(alignment: .leading, spacing: 16) {
                Text("Taskify")
                    .font(.system(size: 38, weight: .bold, design: .rounded))
                    .foregroundStyle(ThemeColors.textPrimary)
                Text("Native iOS onboarding blocks the app until your account key is selected, matching the PWA's first-run gate.")
                    .font(.body)
                    .foregroundStyle(ThemeColors.textSecondary)
                    .frame(maxWidth: 460, alignment: .leading)
            }
            .padding(32)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}
