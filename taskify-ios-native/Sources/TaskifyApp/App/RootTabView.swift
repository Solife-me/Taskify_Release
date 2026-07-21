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
    @EnvironmentObject private var model: AppModel
    @State private var selectedTab: AppTab = .boards

    var body: some View {
        ZStack {
            TaskifyTheme.background.ignoresSafeArea()

            Group {
                switch selectedTab {
                case .boards:
                    BoardsView()
                case .upcoming:
                    UpcomingView()
                case .wallet:
                    MigrationPlaceholderView(
                        title: "Wallet",
                        icon: "dollarsign.circle",
                        detail: "The Cashu wallet and NWC flows will move after task and Nostr sync parity are stable."
                    )
                case .chat:
                    MigrationPlaceholderView(
                        title: "Chat",
                        icon: "message",
                        detail: "Native Nostr messaging is scheduled after the shared relay session is complete."
                    )
                case .settings:
                    SettingsView()
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 8) {
                BottomTabBar(selectedTab: $selectedTab)
            }

            if model.isLoading {
                ProgressView()
                    .controlSize(.large)
                    .tint(.white)
            }
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
    }
}

private struct BottomTabBar: View {
    @EnvironmentObject private var model: AppModel
    @Binding var selectedTab: AppTab

    var body: some View {
        Group {
            if #available(iOS 26.0, *) {
                NativeLiquidGlassTabBar(
                    selectedTab: $selectedTab,
                    upcomingCount: model.upcomingTasks().count
                )
            } else {
                MaterialGlassTabBar(
                    selectedTab: $selectedTab,
                    upcomingCount: model.upcomingTasks().count
                )
            }
        }
        .padding(.horizontal, 14)
    }
}

@available(iOS 26.0, *)
private struct NativeLiquidGlassTabBar: View {
    @Binding var selectedTab: AppTab
    let upcomingCount: Int

    @Namespace private var glassNamespace

    var body: some View {
        GlassEffectContainer(spacing: 8) {
            HStack(spacing: 0) {
                ForEach(AppTab.allCases) { tab in
                    Button {
                        withAnimation(.bouncy(duration: 0.36, extraBounce: 0.04)) {
                            selectedTab = tab
                        }
                    } label: {
                        Group {
                            if selectedTab == tab {
                                BottomTabItem(
                                    tab: tab,
                                    isSelected: true,
                                    upcomingCount: upcomingCount
                                )
                                .frame(maxWidth: .infinity)
                                .frame(height: 56)
                                .contentShape(Capsule())
                                .glassEffect(
                                    .regular
                                        .tint(TaskifyTheme.accent.opacity(0.14))
                                        .interactive(),
                                    in: Capsule()
                                )
                                .glassEffectID("selected-tab", in: glassNamespace)
                                .glassEffectTransition(.matchedGeometry)
                            } else {
                                BottomTabItem(
                                    tab: tab,
                                    isSelected: false,
                                    upcomingCount: upcomingCount
                                )
                                .frame(maxWidth: .infinity)
                                .frame(height: 56)
                                .contentShape(Capsule())
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(tab.title)
                    .accessibilityAddTraits(selectedTab == tab ? .isSelected : [])
                }
            }
            .padding(5)
        }
        .glassEffect(
            .regular.tint(Color.black.opacity(0.10)).interactive(),
            in: Capsule()
        )
        .overlay {
            Capsule()
                .stroke(
                    LinearGradient(
                        colors: [Color.white.opacity(0.32), Color.white.opacity(0.08)],
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

private struct MaterialGlassTabBar: View {
    @Binding var selectedTab: AppTab
    let upcomingCount: Int

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
                        isSelected: selectedTab == tab,
                        upcomingCount: upcomingCount
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
                                                    TaskifyTheme.accent.opacity(0.08),
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
                                .shadow(color: TaskifyTheme.accent.opacity(0.12), radius: 9)
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
    let upcomingCount: Int

    var body: some View {
        VStack(spacing: 3) {
            ZStack(alignment: .topTrailing) {
                Image(systemName: tab.icon)
                    .font(.system(size: 19, weight: isSelected ? .semibold : .medium))
                    .frame(width: 42, height: 30)

                if tab == .upcoming, upcomingCount > 0 {
                    Text(upcomingCount > 99 ? "99+" : "\(upcomingCount)")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 4)
                        .frame(minWidth: 15, minHeight: 15)
                        .background(TaskifyTheme.accent, in: Capsule())
                        .overlay(Capsule().stroke(Color.white.opacity(0.42), lineWidth: 0.6))
                        .offset(x: 5, y: -3)
                }
            }

            Text(tab.title)
                .font(.system(size: 9, weight: isSelected ? .bold : .medium))
                .lineLimit(1)
        }
        .foregroundStyle(
            isSelected
                ? Color(red: 0.66, green: 0.80, blue: 1.0)
                : TaskifyTheme.primaryText
        )
    }
}
