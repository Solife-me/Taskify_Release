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
    @State private var chatScrollPositions: [String: String] = [:]
    @State private var chatSelection: String?
    @State private var printingChecklist = false
    @State private var pendingLink: URL?
    @State private var didHandleInitialLink = false
    @AppStorage(WalletPhaseOut.walletEnabledKey) private var walletEnabled = false

    init(initialLink: URL? = nil, isWalletRecoveryMode: Bool = false) {
        self.initialLink = initialLink
        self.isWalletRecoveryMode = isWalletRecoveryMode
    }

    private var board: Board? { model.board(withID: destination) }
    private var title: String { board?.name ?? MacDestination(rawValue: destination)?.title ?? "Taskify" }
    private var selectedTask: TaskItem? { selectedTaskID.flatMap(model.task(withID:)) }
    private var supportsTasks: Bool { board != nil || destination == "today" || destination == "upcoming" }

    var body: some View {
        NavigationSplitView {
            List(selection: Binding<String?>(get: { destination }, set: { if let value = $0 { destination = value } })) {
                Section("Workspace") {
                    ForEach(MacDestination.allCases.filter { $0 != .wallet || walletEnabled }, id: \.rawValue) { item in
                        Label(item.title, systemImage: item.symbol).tag(item.rawValue)
                    }
                }
                Section {
                    ForEach(model.visibleBoards) { board in
                        Label(board.name, systemImage: board.kind == .week ? "rectangle.split.3x1" : "square.grid.2x2")
                            .tag(board.id)
                            .accessibilityIdentifier(board.id)
                            .accessibilityLabel(board.name)
                            .contextMenu {
                                Button("Board Settings…") { boardToManage = board }
                                Button("Move Up") { _ = model.moveBoard(boardID: board.id, direction: -1) }
                                Button("Move Down") { _ = model.moveBoard(boardID: board.id, direction: 1) }
                                Button("Copy Board Share") { if let value = try? BoardShareContract.encode(board: board) { macCopyExpiring(value) } }
                                Button("Archive Board") { _ = model.archiveBoard(boardID: board.id) }
                            }
                    }
                } header: {
                    HStack {
                        Text("Boards")
                        Spacer()
                        Button { creatingBoard = true } label: { Image(systemName: "plus") }
                            .buttonStyle(.plain).help("New Board")
                    }
                }
                Section("Archived") {
                    ForEach(model.boardsForManagement.filter(\.archived)) { board in
                        Label(board.name, systemImage: "archivebox").tag(board.id)
                            .contextMenu { Button("Restore Board") { _ = model.unarchiveBoard(boardID: board.id) } }
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
        } detail: {
            HSplitView {
                content.frame(maxWidth: .infinity, maxHeight: .infinity)
                if inspectorVisible && supportsTasks, let task = selectedTask {
                    MacTaskInspector(task: task) { editingTask = task }
                        .frame(minWidth: 260, idealWidth: 300, maxWidth: 420)
                }
            }
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
                            Button { inspectorVisible.toggle() } label: { Label("Inspector", systemImage: "sidebar.right") }
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
        .accessibilityIdentifier("taskify-workspace-\(destination)")
        .focusedSceneValue(\.taskifyActions, MacWindowActions(
            newTask: { creatingTask = true }, newBoard: { creatingBoard = true }, sync: { model.retrySync() }
        ))
        .overlay { if model.isLoading { ProgressView("Opening Taskify…").padding(30).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16)) } }
        .sheet(isPresented: $creatingTask) { MacTaskEditor(task: nil, boardID: board?.id ?? model.selectedBoardID) }
        .sheet(item: $editingTask) { task in MacTaskEditor(task: task, boardID: task.boardID) }
        .sheet(isPresented: $creatingEvent) { MacEventEditor(event: nil, initialBoardID: board?.id ?? model.selectedBoardID) }
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
        .onChange(of: destination) { _, newDestination in
            selectedTaskID = MacNavigationSelection.retainedTaskID(
                selectedTaskID: selectedTaskID,
                selectedTaskBoardID: selectedTask?.boardID,
                destination: newDestination
            )
            search = ""
        }
        .onChange(of: model.identityPublicKey) { oldValue, newValue in
            // Empty-to-real is ordinary startup (identity loads after the window already exists)
            // and must not disturb the @SceneStorage-restored destination; only a real account
            // switch — a nonempty identity changing to a different one — should reset. Each
            // window holds its own copy of this state; switching accounts (from any window, since
            // they share one AppModel) must not leave another window's editor open on a
            // task/board/event that belonged to the account just switched away from.
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
            chatScrollPositions = [:]
            destination = "today"
        }
        .onChange(of: notificationRouter.pendingDestination) { _, value in
            guard let value else { return }
            if value.rawValue != MacDestination.wallet.rawValue || walletEnabled {
                destination = value.rawValue
            }
            _ = notificationRouter.consumeDestination()
        }
        .onChange(of: walletEnabled) { _, enabled in
            // Closing the wallet out from its own settings leaves nothing on its page.
            if !enabled && destination == MacDestination.wallet.rawValue { destination = "today" }
        }
        .onAppear {
            // A window restored onto the Wallet page of a device that never used the wallet.
            if destination == MacDestination.wallet.rawValue && !walletEnabled { destination = "today" }
            guard !didHandleInitialLink, let initialLink else { return }
            didHandleInitialLink = true
            openWhenReady(initialLink)
        }
        .onChange(of: model.isLoading) { _, isLoading in
            guard !isLoading, let pendingLink else { return }
            openWhenReady(pendingLink)
        }
        .background {
            WalletPhaseOutNoticePresenter(
                suppressed: model.isLoading || model.showsFirstRunOnboarding,
                openWallet: { destination = MacDestination.wallet.rawValue }
            )
        }
        .onContinueUserActivity(CSSearchableItemActionType, perform: openSearchableItem)
        .onOpenURL(perform: openWhenReady)
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

    @ViewBuilder private var content: some View {
        if let board {
            MacBoardView(board: board, search: search, selectedTaskID: $selectedTaskID, edit: { editingTask = $0 })
        } else {
            switch MacDestination(rawValue: destination) {
            case .today, .upcoming:
                MacAgendaView(todayOnly: destination == "today", search: search, selectedTaskID: $selectedTaskID, edit: { editingTask = $0 })
            case .chat: MacChatView(search: search, drafts: $chatDrafts, scrollPositions: $chatScrollPositions, selection: $chatSelection)
            case .wallet:
                if walletEnabled {
                    if isWalletRecoveryMode {
                        WalletRecoveryView()
                    } else {
                        MacWalletView()
                    }
                } else {
                    MacAgendaView(todayOnly: true, search: search, selectedTaskID: $selectedTaskID, edit: { editingTask = $0 })
                }
            case .inbox: MacInboxView()
            case nil: ContentUnavailableView("Board Unavailable", systemImage: "rectangle.slash", description: Text("Choose another board from the sidebar."))
            }
        }
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
