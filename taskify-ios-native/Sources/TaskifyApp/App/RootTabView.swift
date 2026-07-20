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
        HStack(spacing: 2) {
            ForEach(AppTab.allCases) { tab in
                Button {
                    selectedTab = tab
                } label: {
                    VStack(spacing: 3) {
                        ZStack(alignment: .topTrailing) {
                            Image(systemName: tab.icon)
                                .font(.system(size: 18, weight: .medium))
                                .frame(width: 42, height: 34)
                                .background(
                                    Capsule()
                                        .fill(selectedTab == tab ? Color.white.opacity(0.12) : .clear)
                                )

                            if tab == .upcoming {
                                let count = model.upcomingTasks().count
                                if count > 0 {
                                    Text(count > 99 ? "99+" : "\(count)")
                                        .font(.system(size: 8, weight: .bold))
                                        .padding(.horizontal, 4)
                                        .frame(minWidth: 15, minHeight: 15)
                                        .background(TaskifyTheme.accent, in: Capsule())
                                        .offset(x: 5, y: -2)
                                }
                            }
                        }

                        Text(tab.title)
                            .font(.system(size: 9, weight: selectedTab == tab ? .bold : .medium))
                    }
                    .foregroundStyle(selectedTab == tab ? TaskifyTheme.primaryText : TaskifyTheme.secondaryText)
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tab.title)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().stroke(TaskifyTheme.border, lineWidth: 1))
        .padding(.horizontal, 14)
    }
}
