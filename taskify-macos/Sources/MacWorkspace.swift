import CoreSpotlight
import SwiftUI
import TaskifyCore

private enum MacDestination: String, CaseIterable {
    case today, upcoming, chat, wallet, inbox
    var title: String { rawValue.capitalized }
    var symbol: String {
        switch self {
        case .today: "sun.max"
        case .upcoming: "calendar"
        case .chat: "bubble.left.and.bubble.right"
        case .wallet: "wallet.bifold"
        case .inbox: "tray"
        }
    }
}

private struct MacSplitDestinationMenuItems: View {
    let splitDestination: String?
    let destinations: [MacDestination]
    let boards: [Board]
    let open: (String) -> Void
    let close: () -> Void

    var body: some View {
        if splitDestination != nil {
            Button("Close Split View", action: close)
            Divider()
        }
        ForEach(destinations, id: \.rawValue) { item in
            Button { open(item.rawValue) } label: {
                Label(item.title, systemImage: item.symbol)
            }
        }
        Divider()
        ForEach(boards) { board in
            Button { open(board.id) } label: {
                Label(board.name, systemImage: board.kind == .week ? "rectangle.split.3x1" : "square.grid.2x2")
            }
        }
    }
}

struct MacWorkspace: View {
    @Environment(AppModel.self) private var model
    let initialLink: URL?
    let isWalletRecoveryMode: Bool
    @SceneStorage("mac.destination") private var destination = "today"
    @State private var search = ""
    @State private var selectedTaskID: String?
    @State private var editingTask: TaskItem?
    @State private var creatingTask = false
    @State private var creatingEvent = false
    @State private var creatingBoard = false
    @State private var inspectorVisible = true
    @State private var boardToManage: Board?
    @State private var notificationRouter = TaskNotificationNavigationRouter.shared
    @State private var chatDrafts: [String: String] = [:]
    @State private var chatSelection: String?
    @State private var splitDestination: String?
    @State private var splitSearch = ""
    @State private var splitSelectedTaskID: String?
    @State private var splitEditingTask: TaskItem?
    @State private var splitChatDrafts: [String: String] = [:]
    @State private var splitChatSelection: String?
    @State private var printingChecklist = false
    @State private var pendingLink: URL?
    @State private var didHandleInitialLink = false
    @AppStorage(WalletPhaseOut.walletEnabledKey) private var walletEnabled = false

    init(initialLink: URL? = nil, isWalletRecoveryMode: Bool = false) {
        self.initialLink = initialLink
        self.isWalletRecoveryMode = isWalletRecoveryMode
    }

    private var board: Board? { model.board(withID: destination) }
    private var splitBoard: Board? { splitDestination.flatMap(model.board(withID:)) }
    private var title: String { board?.name ?? MacDestination(rawValue: destination)?.title ?? "Taskify" }
    private var selectedTask: TaskItem? { selectedTaskID.flatMap(model.task(withID:)) }
    private var supportsTasks: Bool {
        board != nil || destination == "today" || destination == "upcoming" ||
            splitBoard != nil || splitDestination == "today" || splitDestination == "upcoming"
    }
    private var commandBoardID: String { board?.id ?? splitBoard?.id ?? model.selectedBoardID }

    var body: some View {
        NavigationSplitView {
            MacWorkspaceSidebar(
                destination: $destination,
                boardToManage: $boardToManage,
                splitDestination: splitDestination,
                walletEnabled: walletEnabled,
                newBoard: { creatingBoard = true },
                openSplit: { openSplitView($0) },
                closeSplit: closeSplitView,
                moveTasks: { values, board in
                    moveDraggedTasks(values, to: board)
                }
            )
        } detail: {
            workspaceDetail
        }
        .accessibilityIdentifier("taskify-workspace-\(destination)")
        .focusedSceneValue(\.taskifyActions, MacWindowActions(
            newTask: { creatingTask = true }, newBoard: { creatingBoard = true }, sync: { model.retrySync() }
        ))
        .overlay { if model.isLoading { ProgressView("Opening Taskify…").padding(30).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16)) } }
        .sheet(isPresented: $creatingTask) { MacTaskEditor(task: nil, boardID: commandBoardID) }
        .sheet(item: $editingTask) { task in MacTaskEditor(task: task, boardID: task.boardID) }
        .sheet(isPresented: $creatingEvent) { MacEventEditor(event: nil, initialBoardID: commandBoardID) }
        .sheet(isPresented: $creatingBoard) { MacBoardEditor(board: nil) }
        .sheet(item: $boardToManage) { board in MacBoardEditor(board: board) }
        .sheet(isPresented: $printingChecklist) {
            if let board {
                MacPrintChecklistSheet(
                    title: board.name,
                    ownerID: "board:\(board.effectiveNostrBoardID)",
                    allItems: MacChecklistItems.forBoard(board, model: model),
                    groups: MacChecklistItems.groups(forBoard: board, model: model)
                )
            }
        }
        .sheet(isPresented: Binding(get: { model.showsFirstRunOnboarding }, set: { _ in })) { MacOnboarding() }
        .alert("Taskify", isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })) {
            Button("OK") { model.errorMessage = nil }
        } message: { Text(model.errorMessage ?? "") }
        .onChange(of: destination) { _, newDestination in handleDestinationChange(newDestination) }
        .onChange(of: model.identityPublicKey) { oldValue, newValue in
            handleAccountChange(oldValue: oldValue, newValue: newValue)
        }
        .onChange(of: notificationRouter.pendingDestination) { _, value in handlePendingDestination(value) }
        .onChange(of: walletEnabled) { _, enabled in handleWalletEnabledChange(enabled) }
        .onAppear(perform: handleAppear)
        .onChange(of: model.isLoading) { _, isLoading in handleLoadingChange(isLoading) }
        .background {
            WalletPhaseOutNoticePresenter(
                suppressed: model.isLoading || model.showsFirstRunOnboarding,
                openWallet: { destination = MacDestination.wallet.rawValue }
            )
        }
        .onContinueUserActivity(CSSearchableItemActionType, perform: openSearchableItem)
        .onOpenURL(perform: openWhenReady)
    }

    private func handleDestinationChange(_ newDestination: String) {
        selectedTaskID = MacNavigationSelection.retainedTaskID(
            selectedTaskID: selectedTaskID,
            selectedTaskBoardID: selectedTask?.boardID,
            destination: newDestination
        )
        search = ""
    }

    private func handleAccountChange(oldValue: String, newValue: String) {
        // Empty-to-real is ordinary startup; only a real account switch resets this window.
        guard !oldValue.isEmpty, oldValue != newValue else { return }
        editingTask = nil
        creatingTask = false
        creatingEvent = false
        creatingBoard = false
        boardToManage = nil
        printingChecklist = false
        selectedTaskID = nil
        chatSelection = nil
        chatDrafts = [:]
        splitDestination = nil
        splitSearch = ""
        splitSelectedTaskID = nil
        splitEditingTask = nil
        splitChatSelection = nil
        splitChatDrafts = [:]
        destination = "today"
    }

    private func handlePendingDestination(_ value: TaskifyNotificationContract.Destination?) {
        guard let value else { return }
        if value.rawValue != MacDestination.wallet.rawValue || walletEnabled {
            destination = value.rawValue
        }
        _ = notificationRouter.consumeDestination()
    }

    private func handleWalletEnabledChange(_ enabled: Bool) {
        guard !enabled else { return }
        if destination == MacDestination.wallet.rawValue { destination = "today" }
        if splitDestination == MacDestination.wallet.rawValue { splitDestination = nil }
    }

    private func handleAppear() {
        if destination == MacDestination.wallet.rawValue && !walletEnabled {
            destination = "today"
        }
        guard !didHandleInitialLink, let initialLink else { return }
        didHandleInitialLink = true
        openWhenReady(initialLink)
    }

    private func handleLoadingChange(_ isLoading: Bool) {
        guard !isLoading, let pendingLink else { return }
        openWhenReady(pendingLink)
    }

    private func openSearchableItem(_ activity: NSUserActivity) {
        if let url = activity.contentAttributeSet?.contentURL {
            openWhenReady(url)
            return
        }
        // Compatibility fallback for an item produced before C11-4 attached a content URL.
        guard let id = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String,
              let task = model.task(withID: id) else { return }
        openWhenReady(TaskifyWidgetLink.task(id: id, boardID: task.boardID).url)
    }

    private func openWhenReady(_ url: URL) {
        guard !model.isLoading else {
            pendingLink = url
            return
        }
        pendingLink = nil
        open(url)
    }

    private func open(_ url: URL) {
        guard let link = TaskifyWidgetLink(url: url) else { return }
        switch link {
        case .upcoming: destination = "upcoming"
        case .event(_, let boardID): destination = boardID
        case .boards: destination = model.selectedBoardID
        case .task(let id, let boardID): destination = boardID; selectedTaskID = id
        case .quickAdd(let boardID, _): destination = boardID ?? model.selectedBoardID; creatingTask = true
        }
    }

    private var content: some View {
        paneContent(
            destination: destination,
            search: search,
            selectedTaskID: $selectedTaskID,
            edit: { editingTask = $0 },
            chatDrafts: $chatDrafts,
            chatSelection: $chatSelection
        )
    }

    private var detailPanes: some View {
        HSplitView {
            content.frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
            if splitDestination != nil {
                splitPane
            } else if inspectorVisible && supportsTasks, let task = selectedTask {
                MacTaskInspector(task: task) { editingTask = task }
                    .frame(minWidth: 260, idealWidth: 300, maxWidth: 420)
            }
        }
    }

    private var workspaceDetail: some View {
        detailPanes
            .navigationTitle(title)
            .searchable(text: $search, prompt: "Search \(title.lowercased())")
            .toolbar {
                if supportsTasks {
                    ToolbarItem {
                        Button { creatingTask = true } label: { Label("New Task", systemImage: "plus") }
                            .help("New Task (⇧⌘N)")
                            .accessibilityIdentifier("new-task-button")
                    }
                    ToolbarItem {
                        Button { creatingEvent = true } label: { Label("New Event", systemImage: "calendar.badge.plus") }
                    }
                    ToolbarItem {
                        Button {
                            if splitDestination == nil { inspectorVisible.toggle() }
                        } label: {
                            Label("Inspector", systemImage: "sidebar.right")
                        }
                        .disabled(splitDestination != nil)
                        .help(splitDestination == nil ? "Show or hide the inspector" : "Close Split View to use the inspector")
                    }
                }
                if let board {
                    if board.kind == .week || board.kind == .list {
                        ToolbarItem {
                            Button { printingChecklist = true } label: { Label("Print Checklist…", systemImage: "printer") }
                        }
                    }
                    ToolbarItem {
                        Button { boardToManage = board } label: { Label("Board Settings", systemImage: "ellipsis.circle") }
                    }
                }
            }
    }

    @ViewBuilder private var splitPane: some View {
        if let splitDestination {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    Menu {
                        splitDestinationMenuItems()
                    } label: {
                        Label(splitPaneTitle(splitDestination), systemImage: splitPaneSymbol(splitDestination))
                            .font(.headline)
                    }
                    if model.board(withID: splitDestination) != nil {
                        TextField("Search split tab", text: $splitSearch)
                            .textFieldStyle(.roundedBorder)
                            .frame(maxWidth: 220)
                    }
                    Spacer()
                    Button { closeSplitView() } label: {
                        Image(systemName: "xmark")
                    }
                    .buttonStyle(.plain)
                    .help("Close Split View")
                    .accessibilityLabel("Close split view")
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(.bar)
                Divider()
                paneContent(
                    destination: splitDestination,
                    search: splitSearch,
                    selectedTaskID: $splitSelectedTaskID,
                    edit: { splitEditingTask = $0 },
                    chatDrafts: $splitChatDrafts,
                    chatSelection: $splitChatSelection
                )
            }
            .frame(minWidth: 560, idealWidth: 640, maxHeight: .infinity)
            .background(Color(nsColor: .windowBackgroundColor))
            .accessibilityIdentifier("split-workspace-\(splitDestination)")
            .sheet(item: $splitEditingTask) { task in
                MacTaskEditor(task: task, boardID: task.boardID)
            }
        }
    }

    @ViewBuilder
    private func paneContent(
        destination target: String,
        search: String,
        selectedTaskID: Binding<String?>,
        edit: @escaping (TaskItem) -> Void,
        chatDrafts: Binding<[String: String]>,
        chatSelection: Binding<String?>
    ) -> some View {
        if let paneBoard = model.board(withID: target) {
            MacBoardView(board: paneBoard, search: search, selectedTaskID: selectedTaskID, edit: edit)
        } else {
            switch MacDestination(rawValue: target) {
            case .today, .upcoming:
                MacAgendaView(
                    todayOnly: target == MacDestination.today.rawValue,
                    search: search,
                    selectedTaskID: selectedTaskID,
                    edit: edit
                )
            case .chat:
                MacChatView(search: search, drafts: chatDrafts, selection: chatSelection)
            case .wallet:
                if walletEnabled {
                    if isWalletRecoveryMode {
                        WalletRecoveryView()
                    } else {
                        MacWalletView()
                    }
                } else {
                    MacAgendaView(todayOnly: true, search: search, selectedTaskID: selectedTaskID, edit: edit)
                }
            case .inbox:
                MacInboxView()
            case nil:
                ContentUnavailableView(
                    "Board Unavailable",
                    systemImage: "rectangle.slash",
                    description: Text("Choose another board from the sidebar.")
                )
            }
        }
    }

    @ViewBuilder private func splitDestinationMenuItems() -> some View {
        MacSplitDestinationMenuItems(
            splitDestination: splitDestination,
            destinations: MacDestination.allCases.filter { $0 != .wallet || walletEnabled },
            boards: model.visibleBoards,
            open: openSplitView,
            close: closeSplitView
        )
    }

    private func openSplitView(_ target: String) {
        if splitDestination != target {
            splitSearch = ""
            splitSelectedTaskID = nil
            splitEditingTask = nil
        }
        splitDestination = target
    }

    private func closeSplitView() {
        splitDestination = nil
        splitSelectedTaskID = nil
        splitEditingTask = nil
    }

    private func splitPaneTitle(_ target: String) -> String {
        model.board(withID: target)?.name ?? MacDestination(rawValue: target)?.title ?? "Split View"
    }

    private func splitPaneSymbol(_ target: String) -> String {
        if let board = model.board(withID: target) {
            return board.kind == .week ? "rectangle.split.3x1" : "square.grid.2x2"
        }
        return MacDestination(rawValue: target)?.symbol ?? "rectangle.split.2x1"
    }

    private func moveDraggedTasks(_ values: [String], to targetBoard: Board) -> Bool {
        let taskIDs = Array(Set(values)).filter { model.task(withID: $0) != nil }
        guard !taskIDs.isEmpty,
              let columnID = MacBoardDropTarget.columnID(
                  in: targetBoard,
                  date: model.currentCalendarDay
              ) else { return false }
        model.moveTasks(taskIDs, toBoardID: targetBoard.id, columnID: columnID)
        return true
    }

}

private struct MacWorkspaceSidebar: View {
    @Environment(AppModel.self) private var model
    @Binding var destination: String
    @Binding var boardToManage: Board?
    let splitDestination: String?
    let walletEnabled: Bool
    let newBoard: () -> Void
    let openSplit: (String) -> Void
    let closeSplit: () -> Void
    let moveTasks: ([String], Board) -> Bool
    @State private var archivedExpanded = false

    var body: some View {
        List(selection: Binding<String?>(
            get: { destination },
            set: { if let value = $0 { destination = value } }
        )) {
            Section("Account") {
                MacAccountSwitcher()
            }
            Section("Workspace") {
                ForEach(MacDestination.allCases.filter { $0 != .wallet || walletEnabled }, id: \.rawValue) { item in
                    Label(item.title, systemImage: item.symbol).tag(item.rawValue)
                }
                Menu {
                    MacSplitDestinationMenuItems(
                        splitDestination: splitDestination,
                        destinations: MacDestination.allCases.filter { $0 != .wallet || walletEnabled },
                        boards: model.visibleBoards,
                        open: openSplit,
                        close: closeSplit
                    )
                } label: {
                    Label(
                        splitDestination == nil ? "Open Split View" : "Change Split View",
                        systemImage: "rectangle.split.2x1"
                    )
                }
                .accessibilityIdentifier("split-view-button")
            }
            Section {
                ForEach(model.visibleBoards) { board in
                    boardRow(board)
                }
            } header: {
                MacBoardsSectionHeader(newBoard: newBoard, restoreArchived: restoreArchivedBoards)
            }
            let archivedBoards = model.boardsForManagement.filter(\.archived)
            if !archivedBoards.isEmpty {
                DisclosureGroup(isExpanded: $archivedExpanded) {
                    ForEach(archivedBoards) { board in
                        archivedBoardRow(board)
                            .draggable(board.id)
                    }
                } label: {
                    HStack {
                        Label("Archived", systemImage: "archivebox")
                        Spacer()
                        Text("\(archivedBoards.count)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                }
            }
            if splitDestination != nil {
                Section("Split View") {
                    Button("Close Split View", systemImage: "xmark.rectangle") { closeSplit() }
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Taskify")
        .navigationSplitViewColumnWidth(min: 190, ideal: 220, max: 300)
        .safeAreaInset(edge: .bottom) {
            VStack(alignment: .leading, spacing: 5) {
                Label(model.syncStatus, systemImage: "arrow.triangle.2.circlepath")
                Text(model.pendingSyncChangeCount == 0 ? "Local changes saved automatically" : "\(model.pendingSyncChangeCount) changes waiting to sync")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .font(.caption).frame(maxWidth: .infinity, alignment: .leading).padding(14)
            .background(.bar)
        }
    }

    private func boardRow(_ board: Board) -> some View {
        MacSidebarBoardRow(board: board) { values, placeAfter in
            handleDropOnBoard(values, targetBoard: board, placeAfter: placeAfter)
        }
        .draggable(board.id)
        .tag(board.id)
        .accessibilityIdentifier(board.id)
        .accessibilityLabel(board.name)
        .contextMenu {
            Button("Board Settings…") { boardToManage = board }
            Button("Move Up") { _ = model.moveBoard(boardID: board.id, direction: -1) }
            Button("Move Down") { _ = model.moveBoard(boardID: board.id, direction: 1) }
            Button("Copy Board Share") {
                if let value = try? BoardShareContract.encode(board: board) {
                    macCopyExpiring(value)
                }
            }
            Button("Archive Board") {
                guard model.archiveBoard(boardID: board.id) else { return }
                archivedExpanded = true
                if destination == board.id { destination = "today" }
            }
        }
    }

    private func archivedBoardRow(_ board: Board) -> some View {
        Label(board.name, systemImage: "archivebox")
            .tag(board.id)
            .contextMenu {
                Button("Restore Board") { _ = model.unarchiveBoard(boardID: board.id) }
            }
    }

    private func restoreArchivedBoards(_ values: [String]) -> Bool {
        let boardIDs = MacBoardDropTarget.archivedBoardIDs(in: values, boards: model.boardsForManagement)
        guard !boardIDs.isEmpty else { return false }
        for boardID in boardIDs {
            _ = model.unarchiveBoard(boardID: boardID)
        }
        if !model.boardsForManagement.contains(where: \.archived) {
            archivedExpanded = false
        }
        return true
    }

    private func handleDropOnBoard(
        _ values: [String],
        targetBoard: Board,
        placeAfter: Bool
    ) -> Bool {
        if restoreArchivedBoards(values) { return true }
        if reorderBoards(values, relativeTo: targetBoard, placeAfter: placeAfter) { return true }
        return moveTasks(values, targetBoard)
    }

    private func reorderBoards(
        _ values: [String],
        relativeTo targetBoard: Board,
        placeAfter: Bool
    ) -> Bool {
        let orderedIDs = model.visibleBoards.map(\.id)
        guard let movingBoardID = values.first(where: orderedIDs.contains),
              let sourceIndex = orderedIDs.firstIndex(of: movingBoardID),
              let finalIndex = MacBoardReorder.finalIndex(
                  orderedBoardIDs: orderedIDs,
                  movingBoardID: movingBoardID,
                  targetBoardID: targetBoard.id,
                  placeAfter: placeAfter
              ) else { return false }
        guard sourceIndex != finalIndex else { return true }

        let direction = finalIndex > sourceIndex ? 1 : -1
        for _ in 0..<abs(finalIndex - sourceIndex) {
            guard model.moveBoard(boardID: movingBoardID, direction: direction) else { break }
        }
        return true
    }
}

private struct MacAccountSwitcher: View {
    @Environment(AppModel.self) private var model
    @EnvironmentObject private var runtime: MacRuntime
    @Environment(\.openSettings) private var openSettings

    private var currentAccount: MacAccountSummary? {
        runtime.savedAccounts.first(where: \.isCurrent)
    }

    var body: some View {
        Menu {
            ForEach(runtime.savedAccounts) { account in
                Button {
                    Task { _ = await runtime.switchAccount(to: account.id) }
                } label: {
                    HStack {
                        Text(account.label)
                        if account.isCurrent { Image(systemName: "checkmark") }
                    }
                }
                .disabled(runtime.isSwitchingAccount || account.isCurrent)
            }
            if runtime.savedAccounts.count > 1 { Divider() }
            Button("Manage Accounts…") { openSettings() }
        } label: {
            HStack(spacing: 9) {
                Image(systemName: "person.crop.circle")
                    .font(.title3)
                VStack(alignment: .leading, spacing: 2) {
                    Text(currentAccount?.label ?? String(model.identityNpub.prefix(16)))
                        .lineLimit(1)
                    Text(String((currentAccount?.npub ?? model.identityNpub).prefix(18)))
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                if runtime.isSwitchingAccount { ProgressView().controlSize(.small) }
            }
        }
        .accessibilityIdentifier("account-switcher")
        .alert(
            "Account",
            isPresented: Binding(
                get: { runtime.accountError != nil },
                set: { if !$0 { runtime.clearAccountError() } }
            )
        ) {
            Button("OK") { runtime.clearAccountError() }
        } message: {
            Text(runtime.accountError ?? "")
        }
    }
}

private struct MacBoardsSectionHeader: View {
    let newBoard: () -> Void
    let restoreArchived: ([String]) -> Bool
    @State private var targeted = false

    var body: some View {
        HStack {
            Label(
                targeted ? "Drop to restore" : "Boards",
                systemImage: targeted ? "arrow.uturn.backward.circle.fill" : "square.grid.2x2"
            )
            Spacer()
            Button(action: newBoard) { Image(systemName: "plus") }
                .buttonStyle(.plain).help("New Board")
        }
        .contentShape(Rectangle())
        .background(targeted ? Color.accentColor.opacity(0.16) : Color.clear, in: RoundedRectangle(cornerRadius: 5))
        .dropDestination(for: String.self) { values, _ in restoreArchived(values) } isTargeted: { targeted = $0 }
    }
}

private struct MacSidebarBoardRow: View {
    let board: Board
    let dropItems: ([String], Bool) -> Bool
    @State private var targeted = false

    var body: some View {
        Label(board.name, systemImage: board.kind == .week ? "rectangle.split.3x1" : "square.grid.2x2")
            .frame(minHeight: 28)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .background(
                targeted ? Color.accentColor.opacity(0.16) : Color.clear,
                in: RoundedRectangle(cornerRadius: 6)
            )
            .overlay(alignment: .trailing) {
                if targeted { Text("Move").font(.caption2.bold()).foregroundStyle(Color.accentColor).padding(.trailing, 4) }
            }
            .accessibilityHint(
                board.kind == .week
                    ? "Drop a task here to move it to today's column, or another board to reorder"
                    : board.kind == .list
                        ? "Drop a task here to move it to the first column, or another board to reorder"
                        : "Drop another board here to reorder"
            )
            .dropDestination(for: String.self) { values, location in
                dropItems(values, location.y > 14)
            } isTargeted: { targeted = $0 }
    }
}

struct MacTaskInspector: View {
    @State private var sharing = false
    @State private var editingNote = false
    let task: TaskItem
    var edit: () -> Void
    @Environment(AppModel.self) private var model
    @AppStorage(TaskPresentationSettings.hideCompletedSubtasksKey)
    private var hideCompletedSubtasks = TaskPresentationSettings.hideCompletedSubtasksDefault
    private var visibleSubtasks: [TaskSubtask] {
        let subtasks = task.subtasks ?? []
        return hideCompletedSubtasks ? subtasks.filter { !$0.completed } : subtasks
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Label("TASK DETAILS", systemImage: "slider.horizontal.3").font(.caption).foregroundStyle(.secondary)
                Text(task.title).font(.title2.bold()).textSelection(.enabled)
                Button(task.completed ? "Mark Incomplete" : "Complete Task", systemImage: task.completed ? "arrow.uturn.backward" : "checkmark.circle") { model.toggleCompletion(task.id) }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("complete-task-button")
                Divider()
                if let date = task.dueDate, task.dueDateEnabled { Label(date.formatted(date: .abbreviated, time: task.dueTimeEnabled ? .shortened : .omitted), systemImage: "calendar") }
                if let priority = task.priority { Label(String(describing: priority).capitalized, systemImage: "flag") }
                notes
                ForEach(visibleSubtasks) { subtask in
                    Button { model.toggleSubtaskCompletion(taskID: task.id, subtaskID: subtask.id) } label: {
                        Label(subtask.title, systemImage: subtask.completed ? "checkmark.circle.fill" : "circle")
                    }.buttonStyle(.plain)
                }
                ForEach(task.documents ?? []) { document in
                    Button(document.name, systemImage: "arrow.down.doc") {
                        Task { do { try await MacAttachmentExport.document(document, boardID: model.board(withID: task.boardID)?.effectiveNostrBoardID ?? task.boardID) } catch { model.errorMessage = error.localizedDescription } }
                    }.font(.caption)
                }
                ForEach(Array((task.images ?? []).enumerated()), id: \.offset) { index, source in
                    Button("Save Image \(index + 1)…", systemImage: "photo") {
                        Task { do { try await MacAttachmentExport.image(source, boardID: model.board(withID: task.boardID)?.effectiveNostrBoardID ?? task.boardID) } catch { model.errorMessage = error.localizedDescription } }
                    }
                }
                Button("Edit Task…", action: edit)
                    .accessibilityIdentifier("edit-task-button")
                Button("Share Task…") { sharing = true }
                Spacer()
                Text("Created \(task.createdAt.formatted(date: .abbreviated, time: .omitted))").font(.caption).foregroundStyle(.tertiary)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(22)
        }.background(.background)
            .sheet(isPresented: $sharing) { MacTaskShare(task: task) }
            .sheet(isPresented: $editingNote) {
                TaskNoteEditorView(note: task.note) { note, subtasks in
                    model.updateTaskNote(taskID: task.id, note: note, appendingSubtasks: subtasks)
                }
            }
    }

    /// The note, rendered, with tickable checklist items. Clicking it opens the note editor.
    @ViewBuilder private var notes: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("NOTES").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button(task.note.isEmpty ? "Add Note…" : "Edit Note…") { editingNote = true }.buttonStyle(.link)
            }
            if !task.note.isEmpty {
                TaskNoteMarkdownView(note: task.note, fontSize: 13) { line in
                    guard let updated = TaskNoteMarkdown.togglingChecklistItem(in: task.note, line: line) else { return }
                    model.updateTaskNote(taskID: task.id, note: updated)
                }
                .contentShape(Rectangle())
                .onTapGesture(count: 2) { editingNote = true }
                .help("Double-click to edit the note")
                if TaskNoteMarkdown.hasChecklistItems(task.note) {
                    TaskNoteConvertChecklistButton(note: task.note) {
                        let result = TaskNoteMarkdown.extractingChecklist(from: task.note)
                        model.updateTaskNote(taskID: task.id, note: result.note, appendingSubtasks: result.subtasks)
                    }
                }
            }
        }
    }
}
