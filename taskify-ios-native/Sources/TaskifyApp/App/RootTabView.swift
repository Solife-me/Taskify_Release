import SwiftUI

enum AppTab: String, CaseIterable, Identifiable {
    case boards
    case upcoming
    case wallet
    case chat
    case settings

    var id: String { rawValue }

    var title: String {
        rawValue.capitalized
    }

    var icon: String {
        switch self {
        case .boards: "square.grid.2x2"
        case .upcoming: "calendar"
        case .wallet: "dollarsign"
        case .chat: "message"
        case .settings: "gearshape"
        }
    }
}

struct RootTabView: View {
    @Environment(AppModel.self) private var model
    @State private var selectedTab: AppTab
    @State private var hasPresentedInitialContent = false

    init() {
#if DEBUG
        let requestedTab = ProcessInfo.processInfo.environment["TASKIFY_INITIAL_TAB"]
            .flatMap(AppTab.init(rawValue:))
        _selectedTab = State(initialValue: requestedTab ?? .boards)
#else
        _selectedTab = State(initialValue: .boards)
#endif
    }

    var body: some View {
        ZStack {
            TaskifyTheme.background.ignoresSafeArea()

            // Building the tab content before the store has loaded renders the entire board
            // against `TaskifySnapshot.empty` — seven day columns with their glass materials
            // and scroll views — and then throws all of it away when the real snapshot lands a
            // few hundred milliseconds later. The spinner covers that pass, so the user never
            // sees it; they only feel the main thread it blocks. Wait for the real data.
            if !model.isLoading {
                if #available(iOS 26.0, *) {
                    nativeTabView
                } else {
                    legacyContent
                        .safeAreaInset(edge: .bottom, spacing: 8) {
                            MaterialGlassTabBar(selectedTab: $selectedTab)
                                .padding(.horizontal, 14)
                        }
                }
            }

            if model.isLoading || !hasPresentedInitialContent {
                ZStack {
                    Color.black.opacity(0.001)
                        .ignoresSafeArea()

                    ProgressView()
                        .controlSize(.large)
                        .tint(.white)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Preparing Taskify")
                .accessibilityIdentifier("taskify-startup-loading")
            }
        }
        .task(id: model.isLoading) {
            guard !model.isLoading, !hasPresentedInitialContent else { return }

            // `snapshot` and `isLoading` can change in the same MainActor turn. Without
            // crossing a display interval, SwiftUI may remove the spinner before it has
            // committed the populated board's first frame, exposing a short frozen screen.
            // Keep the honest loading state up until that frame has had a chance to render.
            await Task.yield()
            try? await Task.sleep(for: .milliseconds(48))
            guard !Task.isCancelled, !model.isLoading else { return }
            hasPresentedInitialContent = true
        }
        .alert(
            "Taskify",
            isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) { model.errorMessage = nil }
        } message: {
            Text(model.errorMessage ?? "")
        }
        .overlay(alignment: .top) {
            WalletStatusToast()
        }
        .fullScreenCover(isPresented: Binding(
            get: { model.showsFirstRunOnboarding },
            set: { _ in }
        )) {
            FirstRunOnboardingView()
                .environment(model)
        }
    }

    @ViewBuilder
    private var legacyContent: some View {
        switch selectedTab {
        case .boards:
            BoardsView()
        case .upcoming:
            UpcomingView()
        case .wallet:
            walletView
        case .chat:
            ContactsView()
        case .settings:
            SettingsView()
        }
    }

    @available(iOS 26.0, *)
    private var nativeTabView: some View {
        TabView(selection: $selectedTab) {
            BoardsView()
                .tag(AppTab.boards)
                .tabItem {
                    Label(AppTab.boards.title, systemImage: AppTab.boards.icon)
                }

            UpcomingView()
                .tag(AppTab.upcoming)
                .tabItem {
                    Label(AppTab.upcoming.title, systemImage: AppTab.upcoming.icon)
                }

            walletView
                .tag(AppTab.wallet)
                .tabItem {
                    Label(AppTab.wallet.title, systemImage: AppTab.wallet.icon)
                }

            ContactsView()
                .tag(AppTab.chat)
                .tabItem {
                    Label(AppTab.chat.title, systemImage: AppTab.chat.icon)
                }

            SettingsView()
                .tag(AppTab.settings)
                .tabItem {
                    Label(AppTab.settings.title, systemImage: AppTab.settings.icon)
                }
        }
    }

    private var walletView: some View {
        WalletView()
    }

}

/// The wallet's transient status banner. Isolated into its own view so a wallet publish
/// invalidates just this overlay. Observing `WalletViewModel` (still `ObservableObject`, so any
/// `@Published` write notifies every observer) directly from `RootTabView` rebuilt the entire
/// tab tree — every tab body — each time the wallet refreshed.
private struct WalletStatusToast: View {
    @EnvironmentObject private var wallet: WalletViewModel

    var body: some View {
        if let message = wallet.statusMessage {
            Text(message)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TaskifyTheme.primaryText)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .taskifyGlassControl(in: Capsule())
                .padding(.top, 62)
                .transition(.move(edge: .top).combined(with: .opacity))
                .task(id: message) {
                    try? await Task.sleep(for: .seconds(2.8))
                    guard wallet.statusMessage == message else { return }
                    withAnimation { wallet.statusMessage = nil }
                }
        }
    }
}

private struct MaterialGlassTabBar: View {
    @Binding var selectedTab: AppTab

    @Namespace private var selectionNamespace

    var body: some View {
        HStack(spacing: 0) {
            ForEach(AppTab.allCases) { tab in
                Button {
                    withAnimation(.spring(response: 0.34, dampingFraction: 0.78)) {
                        selectedTab = tab
                    }
                } label: {
                    BottomTabItem(
                        tab: tab,
                        isSelected: selectedTab == tab
                    )
                    .frame(maxWidth: .infinity)
                    .frame(height: 56)
                    .contentShape(Capsule())
                    .background {
                        if selectedTab == tab {
                            Capsule()
                                .fill(.thinMaterial)
                                .overlay {
                                    Capsule()
                                        .fill(
                                            LinearGradient(
                                                colors: [
                                                    Color.white.opacity(0.16),
                                                    Color.white.opacity(0.04),
                                                    Color.black.opacity(0.10)
                                                ],
                                                startPoint: .topLeading,
                                                endPoint: .bottomTrailing
                                            )
                                        )
                                }
                                .overlay {
                                    Capsule()
                                        .stroke(
                                            LinearGradient(
                                                colors: [Color.white.opacity(0.30), Color.white.opacity(0.06)],
                                                startPoint: .top,
                                                endPoint: .bottom
                                            ),
                                            lineWidth: 0.8
                                        )
                                }
                                .matchedGeometryEffect(id: "selected-tab", in: selectionNamespace)
                                .shadow(color: Color.black.opacity(0.16), radius: 9)
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tab.title)
                .accessibilityAddTraits(selectedTab == tab ? .isSelected : [])
            }
        }
        .padding(5)
        .background(.ultraThinMaterial, in: Capsule())
        .background(Color.black.opacity(0.12), in: Capsule())
        .overlay {
            Capsule()
                .stroke(
                    LinearGradient(
                        colors: [Color.white.opacity(0.26), TaskifyTheme.border.opacity(0.75)],
                        startPoint: .top,
                        endPoint: .bottom
                    ),
                    lineWidth: 0.8
                )
                .allowsHitTesting(false)
        }
        .shadow(color: .black.opacity(0.22), radius: 16, y: 8)
    }
}

private struct BottomTabItem: View {
    let tab: AppTab
    let isSelected: Bool

    var body: some View {
        VStack(spacing: 3) {
            Image(systemName: tab.icon)
                .font(.system(size: 19, weight: isSelected ? .semibold : .medium))
                .frame(width: 42, height: 30)

            Text(tab.title)
                .font(.system(size: 9, weight: isSelected ? .bold : .medium))
                .lineLimit(1)
        }
        .foregroundStyle(TaskifyTheme.primaryText)
    }
}
