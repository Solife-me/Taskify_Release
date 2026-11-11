import CoreSpotlight
import SwiftUI
import TaskifyCore

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

    /// The tabs this device shows. The Wallet tab only appears where the wallet was used
    /// (see `WalletPhaseOut`).
    static func visible(walletEnabled: Bool) -> [AppTab] {
        allCases.filter { $0 != .wallet || walletEnabled }
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
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var watchBridge = TaskifyWatchBridge.shared
    @State private var notificationNavigationRouter = TaskNotificationNavigationRouter.shared
    @State private var selectedTab: AppTab
    @State private var hasPresentedInitialContent = false
    /// Set by a quick-add deep link; BoardsView clears it once it has focused its field.
    @State private var pendingQuickAdd = false
    @State private var pendingQuickAddColumnID: String?
    @State private var pendingWatchSetupRequestID: UUID?
    /// The desktop PWA keeps board creation in its rail. The iPad rail mirrors that placement.
    @State private var showingAddBoardFromSidebar = false
    /// Pushed in by `ChatUnreadCountReader`, so this view re-renders only when the number changes.
    @State private var chatUnreadCount = 0
    /// A task opened from Spotlight, shown in its editor over its board.
    @State private var searchedTask: SearchedTask?
    /// Reading the revision here — rather than the raw appearance flag in each card — is what makes
    /// `taskifyOverPhoto` update the moment a background is chosen or cleared in Settings.
    @AppStorage(TaskifyAppearanceSettings.revisionKey) private var appearanceRevision = ""
    @AppStorage(WalletPhaseOut.walletEnabledKey) private var walletEnabled = false

    init() {
#if DEBUG
        // Wallet UI tests run on fresh installs, which otherwise get no wallet. Written once: this
        // init runs on every parent update, and each write re-renders the @AppStorage readers,
        // which made an endless update loop (the app never idled, so wallet UI tests timed out).
        if ProcessInfo.processInfo.environment["TASKIFY_UI_TEST_WALLET"] == "enabled",
           !UserDefaults.standard.bool(forKey: WalletPhaseOut.walletEnabledKey) {
            UserDefaults.standard.set(true, forKey: WalletPhaseOut.walletEnabledKey)
        }
        let requestedTab = ProcessInfo.processInfo.environment["TASKIFY_INITIAL_TAB"]
            .flatMap(AppTab.init(rawValue:))
        let initialTab = requestedTab ?? StartupViewSettings.tab.appTab
#else
        let initialTab = StartupViewSettings.tab.appTab
#endif
        _selectedTab = State(initialValue: initialTab == .wallet && !WalletPhaseOut.isWalletEnabled ? .boards : initialTab)
    }

    var body: some View {
        content
            .environment(\.taskifyOverPhoto, {
                _ = appearanceRevision
                return TaskifyAppearanceSettings.hasBackgroundImage
            }())
            .focusedSceneValue(\.taskifyNavigator, TaskifyNavigator(
                select: { selectedTab = $0 },
                newTask: {
                    selectedTab = .boards
                    pendingQuickAddColumnID = nil
                    pendingQuickAdd = true
                }
            ))
            .onOpenURL { url in
                guard let link = TaskifyWidgetLink(url: url) else { return }
                handle(link)
            }
            // A Spotlight result opens its task, as a widget row does (C10-7).
            .onContinueUserActivity(CSSearchableItemActionType) { activity in
                guard let id = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String,
                      let task = model.task(withID: id) else { return }
                handle(.task(id: id, boardID: task.boardID))
                searchedTask = SearchedTask(id: id)
            }
            .sheet(item: $searchedTask) { searched in
                if let task = model.task(withID: searched.id) {
                    TaskEditorView(task: task)
                        .environment(model)
                        .presentationDetents([.large])
                        .presentationDragIndicator(.visible)
                }
            }
            // The Control Center button leaves its request in shared defaults rather than opening
            // a URL, so it has to be picked up on launch as well as on every return to the front.
            .onAppear {
                consumeQuickAddRequest()
                routePendingWatchSetup()
                routePendingNotificationDestination()
            }
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active else { return }
                consumeQuickAddRequest()
                routePendingWatchSetup()
            }
            .onChange(of: watchBridge.pendingSetupNavigationRequestID) { _, requestID in
                guard let requestID else { return }
                pendingWatchSetupRequestID = requestID
                selectedTab = .settings
            }
            .onChange(of: walletEnabled) { _, enabled in
                // Closing the wallet out from its own settings leaves nothing on its tab.
                if !enabled && selectedTab == .wallet { selectedTab = .boards }
            }
            .onChange(of: notificationNavigationRouter.pendingDestination) { _, destination in
                guard destination != nil else { return }
                routePendingNotificationDestination()
            }
    }

    private func consumeQuickAddRequest() {
        guard TaskifyQuickAddRequest.consume() else { return }
        handle(.quickAdd(boardID: nil, columnID: nil))
    }

    private func routePendingWatchSetup() {
        guard let requestID = watchBridge.pendingSetupNavigationRequestID else { return }
        pendingWatchSetupRequestID = requestID
        selectedTab = .settings
    }

    private func routePendingNotificationDestination() {
        guard let destination = notificationNavigationRouter.consumeDestination(
            for: model.identityPublicKey
        ) else { return }
        switch destination {
        case .chat:
            selectedTab = .chat
        case .wallet:
            if walletEnabled { selectedTab = .wallet }
        }
    }

    /// Routes a widget's `taskify://` link to the view it represents. Anything the app can't place
    /// is ignored rather than guessed at -- landing somewhere arbitrary is worse than staying put.
    private func handle(_ link: TaskifyWidgetLink) {
        switch link {
        case .upcoming:
            selectedTab = .upcoming
        case .boards:
            selectedTab = .boards
        case .task(_, let boardID):
            // Open the board the task lives on. Selecting it first means Boards shows that board
            // rather than whichever one happened to be open.
            if !boardID.isEmpty { model.selectBoard(boardID) }
            selectedTab = .boards
        case .event(_, let boardID):
            // Events are board content too. Opening their board preserves the widget's context;
            // the native event card remains available there for viewing or editing.
            if !boardID.isEmpty { model.selectBoard(boardID) }
            selectedTab = .boards
        case .quickAdd(let boardID, let columnID):
            if let boardID { model.selectBoard(boardID) }
            selectedTab = .boards
            pendingQuickAddColumnID = columnID
            pendingQuickAdd = true
        }
    }

    private var content: some View {
        ZStack {
            // Building the tab content before the store has loaded renders the entire board
            // against `TaskifySnapshot.empty` — seven day columns with their glass materials
            // and scroll views — and then throws all of it away when the real snapshot lands a
            // few hundred milliseconds later. The spinner covers that pass, so the user never
            // sees it; they only feel the main thread it blocks. Wait for the real data.
            if !model.isLoading {
                if UIDevice.current.userInterfaceIdiom == .pad {
                    ipadNavigation
                } else if #available(iOS 26.0, *) {
                    nativeTabView
                } else if horizontalSizeClass == .regular {
                    tabletNavigation
                } else {
                    legacyContent
                        .safeAreaInset(edge: .bottom, spacing: 8) {
                            MaterialGlassTabBar(
                                selectedTab: $selectedTab,
                                tabs: AppTab.visible(walletEnabled: walletEnabled),
                                chatUnreadCount: chatUnreadCount
                            )
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
        .background {
            // A user-selected photo must never participate in the root ZStack's size proposal.
            // Keeping it in the true background layer makes even panoramic images layout-neutral.
            TaskifyAppBackground()
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
            model.initialContentDidAppear()
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
        .background {
            ChatUnreadCountReader(count: $chatUnreadCount)
        }
        .background {
            WalletPhaseOutNoticePresenter(
                suppressed: model.isLoading || model.showsFirstRunOnboarding,
                openWallet: { selectedTab = .wallet }
            )
        }
        .overlay(alignment: .bottomLeading) {
            TaskifyPerfOverlay()
                .padding(.leading, 8)
                .padding(.bottom, 96)
        }
#if DEBUG
        .overlay(alignment: .top) {
            if let result = model.perfProbeResult {
                Text(result)
                    .font(.caption2)
                    .accessibilityIdentifier("perf-probe")
            }
        }
#endif
        .task {
            TaskifyPerfMonitor.shared.start()
        }
        .fullScreenCover(isPresented: Binding(
            get: { model.showsFirstRunOnboarding },
            set: { _ in }
        )) {
            FirstRunOnboardingView()
                .environment(model)
        }
    }

    private var tabletNavigation: some View {
        NavigationSplitView {
            List(AppTab.visible(walletEnabled: walletEnabled), selection: Binding<AppTab?>(
                get: { selectedTab },
                set: { if let tab = $0 { selectedTab = tab } }
            )) { tab in
                Label(tab.title, systemImage: tab.icon)
                    .badge(tab == .chat ? chatUnreadCount : 0)
                    .tag(tab)
            }
            .navigationTitle("Taskify")
            .navigationSplitViewColumnWidth(min: 200, ideal: 240, max: 280)
        } detail: {
            legacyContent
        }
        .navigationSplitViewStyle(.balanced)
    }

    /// Mirrors the desktop PWA's rail: app destinations stay at the top and the user's boards
    /// remain directly reachable below them. NavigationSplitView still collapses the rail for a
    /// narrow Stage Manager or split-screen window, while the phone continues to use its existing
    /// tab layout.
    private var ipadNavigation: some View {
        NavigationSplitView {
            List {
                Section("Pages") {
                    ForEach(AppTab.visible(walletEnabled: walletEnabled)) { tab in
                        Button {
                            selectedTab = tab
                        } label: {
                            HStack(spacing: 10) {
                                Label(tab.title, systemImage: tab.icon)
                                Spacer(minLength: 8)
                                if tab == .chat, chatUnreadCount > 0 {
                                    Text(chatUnreadCount, format: .number)
                                        .font(.caption.monospacedDigit())
                                        .foregroundStyle(.secondary)
                                        .padding(.horizontal, 7)
                                        .padding(.vertical, 2)
                                        .background(.thinMaterial, in: Capsule())
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(selectedTab == tab ? Color.accentColor : .primary)
                        .listRowBackground(
                            selectedTab == tab
                                ? Color.accentColor.opacity(0.14)
                                : Color.clear
                        )
                        .accessibilityIdentifier("ipad-page-\(tab.rawValue)")
                    }
                }

                Section {
                    ForEach(model.visibleBoards) { board in
                        Button {
                            model.selectBoard(board.id)
                            selectedTab = .boards
                        } label: {
                            Label(board.name, systemImage: ipadBoardIcon(for: board.kind))
                                .lineLimit(1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(
                            selectedTab == .boards && board.id == model.selectedBoardID
                                ? Color.accentColor
                                : .primary
                        )
                        .listRowBackground(
                            selectedTab == .boards && board.id == model.selectedBoardID
                                ? Color.accentColor.opacity(0.14)
                                : Color.clear
                        )
                        .accessibilityIdentifier("ipad-board-\(board.id)")
                    }
                } header: {
                    HStack {
                        Text("Boards")
                        Spacer()
                        Button {
                            showingAddBoardFromSidebar = true
                        } label: {
                            Image(systemName: "plus")
                                .frame(width: 28, height: 28)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Add or join board")
                        .accessibilityIdentifier("ipad-add-board")
                    }
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .background(.ultraThinMaterial)
            .navigationTitle("Taskify")
            .navigationSplitViewColumnWidth(min: 210, ideal: 240, max: 300)
        } detail: {
            legacyContent
                .environment(\.taskifyShowsBoardRail, true)
        }
        .navigationSplitViewStyle(.balanced)
        .sheet(isPresented: $showingAddBoardFromSidebar) {
            BoardAddSheet()
                .environment(model)
        }
    }

    private func ipadBoardIcon(for kind: BoardKind) -> String {
        switch kind {
        case .week: "calendar"
        case .list: "list.bullet.rectangle"
        case .compound: "square.stack.3d.up"
        case .bible: "book.closed"
        }
    }

    @ViewBuilder
    private var legacyContent: some View {
        switch selectedTab {
        case .boards:
            BoardsView(
                focusQuickAdd: $pendingQuickAdd,
                quickAddColumnID: $pendingQuickAddColumnID
            )
        case .upcoming:
            UpcomingView()
        case .wallet:
            if walletEnabled {
                walletView
            } else {
                BoardsView(
                    focusQuickAdd: $pendingQuickAdd,
                    quickAddColumnID: $pendingQuickAddColumnID
                )
            }
        case .chat:
            ContactsView()
        case .settings:
            SettingsView(watchSetupRequestID: $pendingWatchSetupRequestID)
        }
    }

    @available(iOS 26.0, *)
    private var nativeTabView: some View {
        TabView(selection: $selectedTab) {
            Tab(AppTab.boards.title, systemImage: AppTab.boards.icon, value: .boards) {
                BoardsView(
                    focusQuickAdd: $pendingQuickAdd,
                    quickAddColumnID: $pendingQuickAddColumnID
                )
                .taskifyTabBackdrop(isActive: selectedTab == .boards)
            }
            Tab(AppTab.upcoming.title, systemImage: AppTab.upcoming.icon, value: .upcoming) {
                UpcomingView()
                    .taskifyTabBackdrop(isActive: selectedTab == .upcoming)
            }
            if walletEnabled {
                Tab(AppTab.wallet.title, systemImage: AppTab.wallet.icon, value: .wallet) {
                    walletView
                        .taskifyTabBackdrop(isActive: selectedTab == .wallet)
                }
            }
            Tab(value: AppTab.chat) {
                ContactsView()
                    .taskifyTabBackdrop(isActive: selectedTab == .chat)
            } label: {
                Label {
                    Text(AppTab.chat.title)
                } icon: {
                    ChatTabIcon.image(unreadCount: chatUnreadCount)
                }
            }
            .accessibilityValue(ChatTabIcon.accessibilityValue(unreadCount: chatUnreadCount))
            Tab(AppTab.settings.title, systemImage: AppTab.settings.icon, value: .settings) {
                SettingsView(watchSetupRequestID: $pendingWatchSetupRequestID)
                    .taskifyTabBackdrop(isActive: selectedTab == .settings)
            }
        }
        .tabViewStyle(.sidebarAdaptable)
    }

    @ViewBuilder
    private var walletView: some View {
        if WalletPhaseOut.isRecoveryMode {
            WalletRecoveryView()
        } else {
            WalletView()
        }
    }

}

private extension View {
    /// iOS's native TabView supplies an opaque content surface. Put one backdrop inside only the
    /// active tab so the custom photo remains visible without decoding five full-screen copies.
    func taskifyTabBackdrop(isActive: Bool) -> some View {
        background {
            if isActive {
                TaskifyAppBackground()
            }
        }
    }
}

/// Observes the chat threads on `RootTabView`'s behalf. Reading them there would rebuild the whole
/// tab tree on every chat or inbox write, even when the unread total stayed the same.
private struct ChatUnreadCountReader: View {
    @Environment(AppModel.self) private var model
    @Binding var count: Int

    var body: some View {
        Color.clear
            .onChange(of: model.directMessageUnreadCount, initial: true) { _, unreadCount in
                count = unreadCount
            }
    }
}

/// The Chat tab's bubble, with the unread total cut out of it the way the Apple Watch's Messages
/// complication shows it. The tab bar only draws an image from a tab's label, never an arbitrary
/// view, and a template image keeps the bar's own tinting for each selection state.
@MainActor
private enum ChatTabIcon {
    private static var cache: [String: UIImage] = [:]

    @ViewBuilder
    static func image(unreadCount: Int) -> some View {
        if unreadCount > 0, let image = uiImage(label: label(for: unreadCount)) {
            Image(uiImage: image)
        } else {
            Image(systemName: AppTab.chat.icon)
        }
    }

    static func accessibilityValue(unreadCount: Int) -> String {
        switch unreadCount {
        case ...0: ""
        case 1: "1 unread message"
        default: "\(unreadCount) unread messages"
        }
    }

    private static func label(for unreadCount: Int) -> String {
        unreadCount > 99 ? "99+" : String(unreadCount)
    }

    private static func uiImage(label: String) -> UIImage? {
        if let cached = cache[label] { return cached }
        let configuration = UIImage.SymbolConfiguration(pointSize: 25, weight: .medium)
        guard let bubble = UIImage(systemName: "message.fill", withConfiguration: configuration)?
            .withTintColor(.black, renderingMode: .alwaysOriginal) else { return nil }

        let fontSize: CGFloat = label.count > 2 ? 10 : 13
        let text = NSAttributedString(string: label, attributes: [
            .font: UIFont.systemFont(ofSize: fontSize, weight: .heavy),
            .foregroundColor: UIColor.black,
        ])
        let format = UIGraphicsImageRendererFormat.preferred()
        format.opaque = false
        let image = UIGraphicsImageRenderer(size: bubble.size, format: format).image { context in
            bubble.draw(at: .zero)
            context.cgContext.setBlendMode(.destinationOut)
            let textSize = text.size()
            // The tail sits below the bubble, so its visual centre is above the image's.
            text.draw(at: CGPoint(
                x: (bubble.size.width - textSize.width) / 2,
                y: (bubble.size.height - textSize.height) / 2 - 1
            ))
        }.withRenderingMode(.alwaysTemplate)
        cache[label] = image
        return image
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
    let tabs: [AppTab]
    let chatUnreadCount: Int

    @Namespace private var selectionNamespace

    var body: some View {
        HStack(spacing: 0) {
            ForEach(tabs) { tab in
                Button {
                    withAnimation(.spring(response: 0.34, dampingFraction: 0.78)) {
                        selectedTab = tab
                    }
                } label: {
                    BottomTabItem(
                        tab: tab,
                        isSelected: selectedTab == tab,
                        unreadCount: tab == .chat ? chatUnreadCount : 0
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
                .accessibilityValue(tab == .chat ? ChatTabIcon.accessibilityValue(unreadCount: chatUnreadCount) : "")
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
    let unreadCount: Int

    var body: some View {
        VStack(spacing: 3) {
            Group {
                if tab == .chat {
                    ChatTabIcon.image(unreadCount: unreadCount)
                } else {
                    Image(systemName: tab.icon)
                }
            }
            .font(.system(size: 19, weight: isSelected ? .semibold : .medium))
            .frame(width: 42, height: 30)

            Text(tab.title)
                .font(.system(size: 9, weight: isSelected ? .bold : .medium))
                .lineLimit(1)
        }
        .foregroundStyle(TaskifyTheme.primaryText)
    }
}

// MARK: - Hardware keyboard

/// What the scene's keyboard commands act on. Published by `RootTabView` so the commands reach
/// the window that has focus.
struct TaskifyNavigator {
    let select: (AppTab) -> Void
    let newTask: () -> Void
}

private struct TaskifyNavigatorKey: FocusedValueKey {
    typealias Value = TaskifyNavigator
}

extension FocusedValues {
    var taskifyNavigator: TaskifyNavigator? {
        get { self[TaskifyNavigatorKey.self] }
        set { self[TaskifyNavigatorKey.self] = newValue }
    }
}

/// Keyboard shortcuts for an iPad with a hardware keyboard; holding Command lists them.
struct TaskifyKeyboardCommands: Commands {
    @FocusedValue(\.taskifyNavigator) private var navigator
    @AppStorage(WalletPhaseOut.walletEnabledKey) private var walletEnabled = false

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Task") { navigator?.newTask() }
                .keyboardShortcut("n", modifiers: .command)
                .disabled(navigator == nil)
        }
        CommandMenu("Go") {
            ForEach(Array(AppTab.visible(walletEnabled: walletEnabled).enumerated()), id: \.element) { index, tab in
                Button(tab.title) { navigator?.select(tab) }
                    .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
                    .disabled(navigator == nil)
            }
        }
    }
}

/// A task opened from a Spotlight result.
private struct SearchedTask: Identifiable {
    let id: String
}
